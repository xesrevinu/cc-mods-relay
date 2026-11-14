import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** home = ~/Workspace/<rel> (default). opaque = hashed ids. path = legacy hostname+cwd. */
export type WsStyle = "home" | "opaque" | "path";

export type CcModsConfig = {
  /** Namespace for opaque/path layouts. Unused by the default home layout. */
  dir: string;
  ws: WsStyle;
};

export type WsIndexEntry = { cwd: string; host: string; hostDir: string };

const LEGACY_CONFIG_DIR = () => join(homedir(), ".config", "cc-remote");

export function configDir(): string {
  return Bun.env.CC_MODS_CONFIG_DIR ?? join(homedir(), ".config", "cc-mods-relay");
}

export const DEFAULT_WS_PORT = 18765;
export const DEFAULT_WS_PATH = "/session";

const configPath = () => join(configDir(), "config.json");
const indexPath = () => join(configDir(), "ws-index.json");
const hostPath = () => join(configDir(), "host");
const urlPath = () => join(configDir(), "url");
const tokenPath = () => join(configDir(), "token");

let cached: CcModsConfig | undefined;
let indexCache: Record<string, WsIndexEntry> | undefined;

const isStyle = (v: unknown): v is WsStyle => v === "home" || v === "opaque" || v === "path";

function sanitizeDir(raw: string): string {
  const d = raw.trim().replace(/^\/+|\/+$/g, "");
  if (!d || d.includes("..") || d.includes("/") || d.includes("\\")) {
    throw new Error(`cc-mods-relay: invalid dir ${JSON.stringify(raw)} (use a single segment, e.g. Workspace)`);
  }
  return d;
}

function readJson(path: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function writeFileSecure(path: string, body: string): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(path, body, { mode: 0o600 });
}

function migrateLegacyHost(): void {
  if (existsSync(hostPath())) return;
  const legacy = join(LEGACY_CONFIG_DIR(), "host");
  if (!existsSync(legacy)) return;
  try {
    const text = readFileSync(legacy, "utf8");
    if (text.trim()) writeFileSecure(hostPath(), text.endsWith("\n") ? text : `${text}\n`);
  } catch {
    /* best-effort */
  }
}

export function loadConfig(): CcModsConfig {
  if (cached) return cached;
  migrateLegacyHost();
  const file = readJson(existsSync(configPath()) ? configPath() : join(LEGACY_CONFIG_DIR(), "config.json"));
  const hadFile = existsSync(configPath());
  const dir = sanitizeDir(
    Bun.env.CC_MODS_DIR ?? (typeof file.dir === "string" ? file.dir : "Workspace"),
  );
  const wsEnv = Bun.env.CC_MODS_WS;
  const ws: WsStyle = isStyle(wsEnv) ? wsEnv : isStyle(file.ws) ? file.ws : "home";
  cached = { dir, ws };
  if (!hadFile || file.dir !== dir || file.ws !== ws) {
    try {
      writeFileSecure(configPath(), `${JSON.stringify(cached, null, 2)}\n`);
    } catch {
      /* read-only home */
    }
  }
  return cached;
}

export function resetConfigForTests(cfg?: CcModsConfig, index?: Record<string, WsIndexEntry>): void {
  cached = cfg;
  indexCache = index;
}

function readIndex(): Record<string, WsIndexEntry> {
  if (indexCache) return indexCache;
  try {
    indexCache = JSON.parse(readFileSync(indexPath(), "utf8")) as Record<string, WsIndexEntry>;
  } catch {
    indexCache = {};
  }
  return indexCache!;
}

function writeIndex(index: Record<string, WsIndexEntry>): void {
  indexCache = index;
  try {
    writeFileSecure(indexPath(), `${JSON.stringify(index, null, 2)}\n`);
  } catch {
    /* best-effort */
  }
}

export const posix = (path: string) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, "/$1");

export function opaqueId(cwd: string, host = osHostname()): string {
  return createHash("sha256").update(`${host}\0${posix(cwd)}`).digest("hex").slice(0, 16);
}

/** `/Users/<user>` or `/home/<user>` prefix of a client cwd, when the path looks like one. */
export function inferClientHome(cwd: string): string | undefined {
  const n = posix(cwd);
  const m = n.match(/^\/Users\/[^/]+/) || n.match(/^\/home\/[^/]+/);
  return m?.[0];
}

/** Local cwd as a POSIX path relative to the client's home, when possible. `.` means the home itself. */
export function relFromLocalHome(cwd: string, home = homedir()): string {
  let abs = resolve(cwd);
  try {
    abs = realpathSync(cwd);
  } catch {
    /* keep resolve() — cwd may only exist on the client */
  }
  const rel = relative(home, abs);
  if (rel === "" || rel === ".") return ".";
  if (!rel.startsWith("..") && !isAbsolute(rel)) return rel.split(sep).join("/");
  return posix(abs).replace(/^\//, "");
}

function remember(hostDir: string, cwd: string, host: string): void {
  const index = readIndex();
  const prev = index[hostDir];
  if (!prev || prev.cwd !== cwd || prev.host !== host || prev.hostDir !== hostDir) {
    index[hostDir] = { cwd, host, hostDir };
    writeIndex(index);
  }
}

/**
 * Remote folder for this local cwd, relative to the remote home.
 * home (default): the path under the client's home, mirrored onto the server home.
 * opaque: `<dir>/ws/<16-hex>`
 * path: `<dir>/ws/<hostname>/<posix cwd>`
 */
export function hostDirFor(cwd: string, host = osHostname(), home = homedir()): string {
  const { dir, ws } = loadConfig();
  let hostDir: string;
  if (ws === "path") {
    hostDir = `${dir}/ws/${host}${posix(cwd)}`;
  } else if (ws === "opaque") {
    hostDir = `${dir}/ws/${opaqueId(cwd, host)}`;
  } else {
    hostDir = relFromLocalHome(cwd, home);
  }
  remember(hostDir, cwd, host);
  return hostDir;
}

function materializeAbsDir(path: string): boolean {
  if (!path.startsWith("/") || /[\n\r]/.test(path) || path === "/" || path === "/Users" || path === "/home") {
    return false;
  }
  try {
    mkdirSync(path, { recursive: true });
    return existsSync(path);
  } catch {
    return false;
  }
}

/** Create `path` here (and `git init` if needed) so Claude Code `--add-dir` / cwd can use it. */
export function materializeClientDir(path: string): boolean {
  if (path.startsWith("/") && existsSync(path)) {
    ensureGitRepo(path);
    return true;
  }
  if (materializeAbsDir(path)) {
    ensureGitRepo(path);
    return true;
  }
  return false;
}

/** Skip git init at `/Users/<user>` / `/home/<user>` — only project dirs, not the home prefix. */
function isHomePrefix(path: string): boolean {
  return /^\/Users\/[^/]+$/.test(path) || /^\/home\/[^/]+$/.test(path);
}

/**
 * Claude Code's Environment reminder sets `Is a git repository` from this cwd.
 * An empty stub is not a repo; `git init` is enough for the boolean. Skip if
 * `.git` already exists (file or directory, including worktrees).
 */
function ensureGitRepo(dir: string): void {
  if (!dir.startsWith("/") || /[\n\r]/.test(dir) || dir === "/" || dir === "/Users" || dir === "/home") return;
  if (isHomePrefix(dir)) return;
  if (existsSync(join(dir, ".git"))) return;
  try {
    Bun.spawnSync(["git", "init", "-q", dir], { stdout: "ignore", stderr: "ignore" });
  } catch {
    /* git missing */
  }
}

/**
 * Directory the TUI process should `cd` into.
 * Prefer the client's pwd so Claude Code's Environment matches the client path, not the TUI host `$HOME`.
 * Create that path here when missing; fall back to the same path under this `$HOME` if mkdir fails.
 */
export function hostTuiRoot(
  clientCwd: string,
  opts: { home?: string; clientHome?: string; host?: string } = {},
): string {
  if (materializeClientDir(clientCwd)) return clientCwd;
  const home = opts.home ?? homedir();
  const clientHome = opts.clientHome ?? inferClientHome(clientCwd) ?? home;
  const hostDir = hostDirFor(clientCwd, opts.host ?? osHostname(), clientHome);
  if (hostDir === "." || hostDir === "") return home;
  return join(home, hostDir);
}

export function cwdForHostDir(hostDir: string): string | undefined {
  return readIndex()[hostDir]?.cwd;
}

export function knownHostDirs(): Record<string, WsIndexEntry> {
  return { ...readIndex() };
}

/** ssh destination: `--host`, `$CC_MODS_HOST`, then the config file (migrated from cc-remote if needed). */
export async function configuredHost(): Promise<string | undefined> {
  const env = Bun.env.CC_MODS_HOST || Bun.env.CC_REMOTE_HOST;
  if (env?.trim()) return env.trim();
  migrateLegacyHost();
  const file = Bun.file(hostPath());
  if (!(await file.exists())) return undefined;
  const text = (await file.text()).trim();
  return text || undefined;
}

function asWsUrl(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  if (text.startsWith("ws://") || text.startsWith("wss://")) return text.replace(/\/+$/, "");
  if (text.startsWith("http://")) return `ws://${text.slice("http://".length)}`.replace(/\/+$/, "");
  if (text.startsWith("https://")) return `wss://${text.slice("https://".length)}`.replace(/\/+$/, "");
  return undefined;
}

/** Persistent server URL: `--url`, `$CC_MODS_URL`, then `url` / legacy `host` if it is a ws URL. */
export async function configuredUrl(): Promise<string | undefined> {
  const env = Bun.env.CC_MODS_URL?.trim();
  if (env) return asWsUrl(env) ?? env.replace(/\/+$/, "");
  const file = Bun.file(urlPath());
  if (await file.exists()) {
    const text = (await file.text()).trim();
    if (text) return asWsUrl(text) ?? text.replace(/\/+$/, "");
  }
  const host = await configuredHost();
  if (host) return asWsUrl(host);
  return undefined;
}

export async function configuredToken(): Promise<string | undefined> {
  const env = Bun.env.CC_MODS_TOKEN?.trim();
  if (env) return env;
  const file = Bun.file(tokenPath());
  if (!(await file.exists())) return undefined;
  const text = (await file.text()).trim();
  return text || undefined;
}

export function writeServerToken(token: string): string {
  const path = tokenPath();
  writeFileSecure(path, `${token}\n`);
  return path;
}

export function sessionUrl(host: string, port: number, path = DEFAULT_WS_PATH): string {
  return `ws://${host}:${port}${path}`;
}

export function httpUrlFromWs(wsUrl: string, path = "/health"): string {
  const u = new URL(wsUrl);
  const proto = u.protocol === "wss:" ? "https:" : "http:";
  return `${proto}//${u.host}${path}`;
}
