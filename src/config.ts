import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** home = ~/Workspace/<rel> (default). opaque = hashed ids. path = legacy hostname+cwd. */
export type WsStyle = "home" | "opaque" | "path";

export type CcModsConfig = {
  /** Single segment under the remote $HOME. Default "Workspace". */
  dir: string;
  ws: WsStyle;
};

export type WsIndexEntry = { cwd: string; host: string; hostDir: string };

const LEGACY_CONFIG_DIR = () => join(homedir(), ".config", "cc-remote");

export function configDir(): string {
  return Bun.env.CC_MODS_CONFIG_DIR ?? join(homedir(), ".config", "cc-mods-relay");
}

const configPath = () => join(configDir(), "config.json");
const indexPath = () => join(configDir(), "ws-index.json");
const hostPath = () => join(configDir(), "host");

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

/** Local cwd as a POSIX path relative to the local home, when possible. `.` means the home itself. */
export function relFromLocalHome(cwd: string): string {
  let abs = resolve(cwd);
  try {
    abs = realpathSync(cwd);
  } catch {
    /* keep resolve() */
  }
  const rel = relative(homedir(), abs);
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
 * home (default): `Workspace/<path under local home>`.
 * opaque: `<dir>/ws/<16-hex>`
 * path: `<dir>/ws/<hostname>/<posix cwd>`
 */
export function hostDirFor(cwd: string, host = osHostname()): string {
  const { dir, ws } = loadConfig();
  let hostDir: string;
  if (ws === "path") {
    hostDir = `${dir}/ws/${host}${posix(cwd)}`;
  } else if (ws === "opaque") {
    hostDir = `${dir}/ws/${opaqueId(cwd, host)}`;
  } else {
    const rel = relFromLocalHome(cwd);
    if (rel === "." || rel === "") hostDir = dir;
    else if (rel === dir || rel.startsWith(`${dir}/`)) hostDir = rel;
    else hostDir = `${dir}/${rel}`;
  }
  remember(hostDir, cwd, host);
  return hostDir;
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
