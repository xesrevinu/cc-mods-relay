import { closeSync, fstatSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, posix, sep } from "node:path";
import { configDir } from "./config.js";
import { claudeConfigDir } from "./jsonl.js";

/** Byte slices over the WebSocket. Matches `readFileTail`'s default window. */
export const TRANSCRIPT_CHUNK_BYTES = 512 * 1024;

export const TRANSCRIPT_SIDECAR_SUFFIX = ".cc-mods-mirror";

export type TranscriptCursor = { rel: string; offset: number };
export type TranscriptCursors = Record<string, TranscriptCursor>;

export type TranscriptSidecar = {
  sessionId: string;
  size: number;
  mirroredAt: string;
  via: string;
};

/** Claude Code's `~/.claude/projects/<encoded cwd>/` folder name. */
export function encodeProjectDir(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, "");
  return trimmed.replaceAll("/", "-");
}

export function sessionIdFromRel(rel: string): string {
  const base = posix.basename(rel);
  return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}

export function isSafeTranscriptRel(rel: string): boolean {
  if (!rel || rel.startsWith("/") || rel.includes("\0") || rel.includes("\\")) return false;
  if (rel.includes("..") || rel.startsWith("./") || rel.includes("/./")) return false;
  if (!rel.endsWith(".jsonl") || rel.endsWith(TRANSCRIPT_SIDECAR_SUFFIX)) return false;
  return posix.normalize(rel) === rel;
}

export function parseTranscriptCursors(raw: unknown): TranscriptCursors {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: TranscriptCursors = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || !value || typeof value !== "object") continue;
    const row = value as { rel?: unknown; offset?: unknown };
    if (typeof row.rel !== "string" || !isSafeTranscriptRel(row.rel)) continue;
    if (typeof row.offset !== "number" || !Number.isFinite(row.offset) || row.offset < 0) continue;
    out[id] = { rel: row.rel, offset: Math.floor(row.offset) };
  }
  return out;
}

export function cursorsPath(dir = configDir()): string {
  return join(dir, "transcript-cursors.json");
}

export function loadTranscriptCursors(dir = configDir()): TranscriptCursors {
  try {
    return parseTranscriptCursors(JSON.parse(readFileSync(cursorsPath(dir), "utf8")));
  } catch {
    return {};
  }
}

export function saveTranscriptCursors(cursors: TranscriptCursors, dir = configDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(cursorsPath(dir), `${JSON.stringify(cursors)}\n`, { mode: 0o600 });
}

export function rememberTranscriptCursor(
  sessionId: string,
  cursor: TranscriptCursor,
  dir = configDir(),
): TranscriptCursors {
  const cursors = loadTranscriptCursors(dir);
  cursors[sessionId] = cursor;
  saveTranscriptCursors(cursors, dir);
  return cursors;
}

export function localProjectsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(claudeConfigDir(env), "projects");
}

export function sidecarPath(jsonlPath: string): string {
  return `${jsonlPath}${TRANSCRIPT_SIDECAR_SUFFIX}`;
}

export function writeTranscriptSidecar(jsonlPath: string, sidecar: TranscriptSidecar): void {
  writeFileSync(sidecarPath(jsonlPath), `${JSON.stringify(sidecar)}\n`);
}

/**
 * Write `bytes` at `offset` under `projectsRoot/<rel>`. Skips a gap (offset past EOF)
 * so a later offset-0 pass can rebuild the file.
 */
export function applyTranscriptChunk(
  projectsRoot: string,
  rel: string,
  offset: number,
  bytes: Uint8Array,
  opts: { via?: string; now?: () => string; configDir?: string } = {},
): { path: string; size: number } | undefined {
  if (!isSafeTranscriptRel(rel) || !Number.isFinite(offset) || offset < 0) return undefined;
  const dest = join(projectsRoot, rel.split("/").join(sep));
  mkdirSync(dirname(dest), { recursive: true });
  const fd = openSync(dest, "a+");
  try {
    const size = fstatSync(fd).size;
    if (offset === 0) {
      ftruncateSync(fd, 0);
      writeSync(fd, bytes, 0, bytes.length, 0);
    } else if (offset > size) {
      return undefined;
    } else {
      writeSync(fd, bytes, 0, bytes.length, offset);
    }
    const next = offset + bytes.length;
    const sessionId = sessionIdFromRel(rel);
    writeTranscriptSidecar(dest, {
      sessionId,
      size: next,
      mirroredAt: (opts.now ?? (() => new Date().toISOString()))(),
      via: opts.via ?? "ws",
    });
    rememberTranscriptCursor(sessionId, { rel, offset: next }, opts.configDir);
    return { path: dest, size: next };
  } finally {
    closeSync(fd);
  }
}

export function decodeTranscriptData(data: unknown): Uint8Array | undefined {
  if (typeof data !== "string" || !data) return undefined;
  try {
    return Buffer.from(data, "base64");
  } catch {
    return undefined;
  }
}

export function applyTranscriptFrame(
  frame: { rel?: unknown; offset?: unknown; data?: unknown },
  projectsRoot = localProjectsRoot(),
  opts?: { via?: string; configDir?: string },
): { path: string; size: number } | undefined {
  if (typeof frame.rel !== "string" || typeof frame.offset !== "number") return undefined;
  const bytes = decodeTranscriptData(frame.data);
  if (!bytes || bytes.length === 0) return undefined;
  return applyTranscriptChunk(projectsRoot, frame.rel, frame.offset, bytes, opts);
}

export function projectFolderNames(cwd: string, extra: string[] = []): string[] {
  const names = new Set<string>();
  for (const path of [cwd, ...extra]) {
    if (typeof path === "string" && path.startsWith("/")) names.add(encodeProjectDir(path));
  }
  return [...names];
}

export function cursorOffsetFor(cursors: TranscriptCursors, rel: string, size: number): number {
  const sessionId = sessionIdFromRel(rel);
  const hit = cursors[sessionId];
  if (!hit || hit.rel !== rel) return 0;
  if (hit.offset > size) return 0;
  return hit.offset;
}

function posixRel(from: string, to: string): string {
  return to.slice(from.length).replaceAll(sep, "/").replace(/^\//, "");
}

/** Every `*.jsonl` under a Claude `projects/` tree, including subagent files. */
export function listProjectJsonl(projectsRoot: string, folderNames?: string[]): string[] {
  const out: string[] = [];
  let names = folderNames;
  if (!names) {
    try {
      names = readdirSync(projectsRoot).filter((name) => {
        if (!name || name.startsWith(".")) return false;
        try {
          return statSync(join(projectsRoot, name)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  }
  for (const name of names) {
    if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) continue;
    const dir = join(projectsRoot, name);
    const stack = [dir];
    while (stack.length) {
      const here = stack.pop()!;
      let entries: string[];
      try {
        entries = readdirSync(here);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.endsWith(TRANSCRIPT_SIDECAR_SUFFIX)) continue;
        const path = join(here, entry);
        let st;
        try {
          st = statSync(path);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          stack.push(path);
          continue;
        }
        if (!entry.endsWith(".jsonl")) continue;
        const rel = posixRel(projectsRoot, path);
        if (isSafeTranscriptRel(rel)) out.push(rel);
      }
    }
  }
  return out.sort();
}

export function stampLocalTranscripts(
  projectsRoot: string,
  via: string,
  opts: { now?: () => string; configDir?: string } = {},
): { files: number; cursors: TranscriptCursors } {
  const now = opts.now ?? (() => new Date().toISOString());
  const cursors = loadTranscriptCursors(opts.configDir);
  const rels = listProjectJsonl(projectsRoot);
  for (const rel of rels) {
    const path = join(projectsRoot, rel.split("/").join(sep));
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      continue;
    }
    const sessionId = sessionIdFromRel(rel);
    writeTranscriptSidecar(path, { sessionId, size, mirroredAt: now(), via });
    cursors[sessionId] = { rel, offset: size };
  }
  saveTranscriptCursors(cursors, opts.configDir);
  return { files: rels.length, cursors };
}
