import { statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

type FileStamp = { mtimeMs: number; size: number };

const MAX_FILES_PER_SESSION = 64;
const MAX_SESSIONS = 64;
const tracked = new Map<string, Map<string, FileStamp>>();

function readStamp(filePath: string): FileStamp | undefined {
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return undefined;
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return undefined;
  }
}

function sessionMap(sessionId: string): Map<string, FileStamp> {
  let map = tracked.get(sessionId);
  if (map) {
    tracked.delete(sessionId);
    tracked.set(sessionId, map);
    return map;
  }
  if (tracked.size >= MAX_SESSIONS) {
    const oldest = tracked.keys().next().value;
    if (oldest !== undefined) tracked.delete(oldest);
  }
  map = new Map();
  tracked.set(sessionId, map);
  return map;
}

/** Remember a file's mtime/size after Read, Write, or Edit so Bash can detect external modifications. */
export function recordReadFile(sessionId: string | undefined, filePath: string | undefined): void {
  if (!sessionId || !filePath) return;
  const abs = resolve(filePath);
  const stamp = readStamp(abs);
  if (!stamp) return;
  const map = sessionMap(sessionId);
  if (map.has(abs)) map.delete(abs);
  if (map.size >= MAX_FILES_PER_SESSION) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(abs, stamp);
}

function displayPath(cwd: string, abs: string): string {
  const rel = relative(cwd, abs);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  return abs;
}

/**
 * After a foreground Bash completes on this machine, stat recently read files
 * and emit Claude Code's native `staleReadFileStateHint` for any whose mtime or
 * size changed during the command.
 */
export function detectModifiedReadFiles(sessionId: string | undefined, cwd: string): string | undefined {
  if (!sessionId) return undefined;
  const map = tracked.get(sessionId);
  if (!map || map.size === 0) return undefined;
  const modified: string[] = [];
  for (const [abs, prev] of map) {
    const cur = readStamp(abs);
    if (!cur) continue;
    if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) {
      map.set(abs, cur);
      modified.push(displayPath(cwd, abs));
    }
  }
  if (modified.length === 0) return undefined;
  const shown = modified.slice(0, 5).join(", ");
  const more = modified.length > 5 ? ` and ${modified.length - 5} more` : "";
  const noun = modified.length === 1 ? "file" : "files";
  return `[This command modified ${modified.length} ${noun} you've previously read: ${shown}${more}. Call Read before editing.]`;
}

export function clearReadState(sessionId: string | undefined): void {
  if (!sessionId) return;
  tracked.delete(sessionId);
}
