import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export function inside(root: string, abs: string): string {
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Path is outside ${root}`);
  return abs;
}

function under(root: string, abs: string): string | undefined {
  try {
    return inside(root, abs);
  } catch {
    return undefined;
  }
}

function posixPath(p: string): string {
  return p.replaceAll("\\", "/");
}

function userHomePrefix(abs: string): string | undefined {
  const n = posixPath(abs);
  const m = n.match(/^\/Users\/[^/]+/) || n.match(/^\/home\/[^/]+/);
  return m?.[0];
}

export function localHome(): string {
  return posixPath(homedir());
}

/** TUI host `$HOME` taken from the Mini session cwd (`/Users/<user>`, `/home/<user>`, …). */
export function remoteHome(tuiRoot?: string): string | undefined {
  if (!tuiRoot) return undefined;
  return userHomePrefix(posixPath(resolve(tuiRoot)));
}

/** Claude Code scratch plus the process temp dir. Always writable alongside cwd. */
export function scratchDirs(): string[] {
  const dirs = [join(homedir(), ".cursor", "artifacts"), tmpdir()];
  if (process.platform !== "win32") dirs.push("/tmp");
  return [...new Set(dirs.map((d) => resolve(d)))];
}

/** Claude Code folder names: every non-alphanumeric becomes `-` (`.cursor` → `-cursor`). */
export function encodeClaudeDir(cwd: string): string {
  return cwd.replace(/\/+$/, "").replace(/[^a-zA-Z0-9]/g, "-");
}

/** Claude Code auto-memory: `~/.claude/projects/<encoded>/memory/*.md`. */
export function isClaudeMemoryPath(abs: string): boolean {
  const prefix = `${posixPath(homedir())}/.claude/projects/`;
  const n = posixPath(abs);
  return n.startsWith(prefix) && /\/memory\/[^/]+$/.test(n);
}

export function mergeRoots(extraDirs: string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of [...extraDirs, ...scratchDirs()]) {
    if (!dir) continue;
    const abs = resolve(dir);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

function byLongestFrom(aliases: [string, string][]): [string, string][] {
  return [...aliases].sort((a, b) => b[0].length - a[0].length);
}

/**
 * Inbound: TUI host view → this machine.
 * Session root first (`tuiRoot` → project), then `$HOME` (TUI host home → client home).
 * Not a hardcoded `Workspace` or `.cursor` rule — those fall out of the two prefixes.
 */
export function pathAliases(project: string, tuiRoot?: string): [string, string][] {
  const aliases: [string, string][] = [];
  if (tuiRoot) {
    const from = posixPath(resolve(tuiRoot));
    const to = posixPath(resolve(project));
    if (from !== to) aliases.push([from, to]);
  }
  const remote = remoteHome(tuiRoot);
  const local = localHome();
  if (remote && local && remote !== local) aliases.push([remote, local]);
  return byLongestFrom(aliases);
}

/** End of a path prefix: slash, EOS, or a character that cannot continue a path segment. */
const PATH_TAIL = String.raw`(?:/|$|[^A-Za-z0-9._-])`;

function replacePathPrefix(text: string, from: string, to: string): string {
  if (!from || !text.includes(from)) return text;
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`${escaped}(?=${PATH_TAIL})`, "g"), () => to);
}

function applyAliases(text: string, aliases: [string, string][]): string {
  let out = text;
  for (const [from, to] of aliases) out = replacePathPrefix(out, from, to);
  return out;
}

/**
 * Tilde expansion only at the start of a path token (`~/x`, `cd ~`, `VAR=~/x`).
 * Identifier suffixes (`token~`) and bash/perl `=~` are left alone.
 */
function expandTildeInText(text: string, home: string): string {
  if (!text.includes("~")) return text;
  return text.replace(
    /(^|[^A-Za-z0-9._-])~(?=\/)|(^|[^A-Za-z0-9._=-])~(?=$|[^A-Za-z0-9._/-])/g,
    (_full, slashLeft: string | undefined, bareLeft: string | undefined) => `${slashLeft ?? bareLeft}${home}`,
  );
}

function expandRemoteHomesInText(text: string, tuiRoot?: string): string {
  const remote = remoteHome(tuiRoot) ?? localHome();
  const out = replacePathPrefix(text, "$HOME", remote);
  return expandTildeInText(out, remote);
}

function expandRemoteHome(path: string, tuiRoot?: string): string {
  const remote = remoteHome(tuiRoot) ?? localHome();
  if (path === "~" || path === "$HOME") return remote;
  if (path.startsWith("~/")) return remote + path.slice(1);
  if (path.startsWith("$HOME")) return remote + path.slice("$HOME".length);
  return path;
}

export function rewriteRemoteText(text: string, project: string, tuiRoot?: string): string {
  return applyAliases(expandRemoteHomesInText(text, tuiRoot), pathAliases(project, tuiRoot));
}

export function rewriteRemotePath(path: string, project: string, tuiRoot?: string): string {
  let out = expandRemoteHome(path, tuiRoot);
  for (const [from, to] of pathAliases(project, tuiRoot)) {
    if (out === from || out.startsWith(`${from}/`)) {
      out = to + out.slice(from.length);
      break;
    }
  }
  return out;
}

/**
 * `cwd` is the session working directory (may be a subdir or worktree).
 * `project` is the bound workspace root; TUI host paths remap onto it.
 */
export function mapPath(
  cwd: string,
  tuiRoot: string | undefined,
  path: string,
  extraDirs: string[] = [],
  project?: string,
): string {
  const rootProject = resolve(project || cwd);
  const rewritten = rewriteRemotePath(path, rootProject, tuiRoot);
  const tui = tuiRoot ? resolve(tuiRoot) : cwd;
  const abs = isAbsolute(rewritten) ? resolve(rewritten) : resolve(cwd, rewritten);
  if (tuiRoot) {
    const fromTui = relative(tui, abs);
    if (fromTui === "") return inside(rootProject, rootProject);
    if (!fromTui.startsWith("..") && !isAbsolute(fromTui)) {
      return inside(rootProject, resolve(rootProject, fromTui));
    }
  }
  const hit = under(cwd, abs) ?? under(rootProject, abs);
  if (hit) return hit;
  for (const extra of mergeRoots(extraDirs)) {
    const mapped = under(resolve(extra), abs);
    if (mapped) return mapped;
  }
  return inside(rootProject, abs);
}

function homeQualified(path: string): boolean {
  return (
    isAbsolute(path) ||
    path === "~" ||
    path.startsWith("~/") ||
    path === "$HOME" ||
    path.startsWith("$HOME/") ||
    path.startsWith("$HOME\\")
  );
}

/**
 * Read/Grep/Glob: workspace, extraDirs, scratch, or an explicit path under $HOME.
 * Relative `../` still cannot walk out. Write/Edit keep using `mapPath`.
 */
export function mapReadPath(
  cwd: string,
  tuiRoot: string | undefined,
  path: string,
  extraDirs: string[] = [],
  project?: string,
): string {
  try {
    return mapPath(cwd, tuiRoot, path, extraDirs, project);
  } catch (error) {
    if (!homeQualified(path)) throw error;
    const abs = resolve(rewriteRemotePath(path, project || cwd, tuiRoot));
    if (under(homedir(), abs)) return abs;
    throw error;
  }
}

/** Workspace, extraDirs, and scratch — the roots Bash may persist as session cwd for later Write. */
export function insideWriteRoot(abs: string, project: string, extraDirs: string[] = []): boolean {
  const target = resolve(abs);
  if (under(resolve(project), target)) return true;
  for (const extra of mergeRoots(extraDirs)) {
    if (under(resolve(extra), target)) return true;
  }
  return false;
}

/** Like mapPath, but a directory under $HOME is allowed (EnterWorktree / persisted pwd). */
export function mapCwd(
  cwd: string,
  tuiRoot: string | undefined,
  path: string,
  extraDirs: string[] = [],
  project?: string,
): string {
  try {
    return mapPath(cwd, tuiRoot, path, extraDirs, project);
  } catch (error) {
    const abs = resolve(rewriteRemotePath(path, project || cwd, tuiRoot));
    if (under(homedir(), abs)) return abs;
    throw error;
  }
}

/**
 * Write/Edit: workspace, extraDirs, scratch — plus Claude Code `memory/*.md`.
 * Other `$HOME` paths stay jailed.
 */
export function mapWritePath(
  cwd: string,
  tuiRoot: string | undefined,
  path: string,
  extraDirs: string[] = [],
  project?: string,
): string {
  try {
    return mapPath(cwd, tuiRoot, path, extraDirs, project);
  } catch (error) {
    if (!homeQualified(path)) throw error;
    const abs = resolve(rewriteRemotePath(path, project || cwd, tuiRoot));
    if (isClaudeMemoryPath(abs)) return abs;
    throw error;
  }
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
