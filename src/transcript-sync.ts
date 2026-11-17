import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, watch } from "node:fs";
import { join, sep } from "node:path";
import {
  cursorOffsetFor,
  isSafeTranscriptRel,
  listProjectJsonl,
  TRANSCRIPT_CHUNK_BYTES,
  TRANSCRIPT_SIDECAR_SUFFIX,
  type TranscriptCursors,
} from "./transcript-mirror.js";

export type TranscriptAppendFrame = {
  v: 1;
  type: "transcript.append";
  rel: string;
  offset: number;
  data: string;
  size: number;
};

export type TranscriptSyncOpts = {
  claudeConfigDir: string;
  cursors?: TranscriptCursors;
  send: (msg: TranscriptAppendFrame) => void;
  chunkBytes?: number;
  /** 0 (default) = event-driven only. Tests may poll. */
  pollMs?: number;
  /** Extra flush after turn.complete, once Claude has written the JSONL. */
  idleMs?: number;
  watch?: boolean;
};

export type TranscriptSync = {
  flush(): void;
  onTurnStart(): void;
  onTurnComplete(): void;
  stop(): void;
};

function readBytes(path: string, from: number, length: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, from + read);
      if (n <= 0) break;
      read += n;
    }
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function sendFile(
  projectsRoot: string,
  rel: string,
  fromOffset: number,
  send: TranscriptSyncOpts["send"],
  chunkBytes: number,
): number {
  const path = join(projectsRoot, rel.split("/").join(sep));
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return fromOffset;
  }
  let offset = fromOffset > size ? 0 : fromOffset;
  while (offset < size) {
    const n = Math.min(chunkBytes, size - offset);
    const buf = readBytes(path, offset, n);
    if (buf.length === 0) break;
    send({
      v: 1,
      type: "transcript.append",
      rel,
      offset,
      data: buf.toString("base64"),
      size,
    });
    offset += buf.length;
  }
  return offset;
}

/**
 * Push Claude Code session JSONL over the persistent WS.
 * Init is rsync on the client; this path is the live tail, keyed off turn and idle events.
 */
export function startTranscriptSync(opts: TranscriptSyncOpts): TranscriptSync {
  const projectsRoot = join(opts.claudeConfigDir, "projects");
  mkdirSync(projectsRoot, { recursive: true });
  const cursors: TranscriptCursors = { ...(opts.cursors ?? {}) };
  const chunkBytes = opts.chunkBytes ?? TRANSCRIPT_CHUNK_BYTES;
  const sent = new Map<string, number>();
  const idleMs = opts.idleMs ?? 1_000;
  let stopped = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const flushRel = (rel: string) => {
    if (stopped || !isSafeTranscriptRel(rel)) return;
    const path = join(projectsRoot, rel.split("/").join(sep));
    if (!existsSync(path)) return;
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      return;
    }
    const have = sent.get(rel) ?? cursorOffsetFor(cursors, rel, size);
    if (have >= size) {
      sent.set(rel, have);
      return;
    }
    sent.set(rel, sendFile(projectsRoot, rel, have, opts.send, chunkBytes));
  };

  const flush = () => {
    if (stopped) return;
    for (const rel of listProjectJsonl(projectsRoot)) flushRel(rel);
  };

  const onTurnStart = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const onTurnComplete = () => {
    flush();
    if (stopped || idleMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      flush();
    }, idleMs);
    if (typeof idleTimer === "object" && "unref" in idleTimer) idleTimer.unref();
  };

  flush();

  let watcher: { close(): void } | undefined;
  if (opts.watch !== false) {
    try {
      watcher = watch(projectsRoot, { recursive: true }, (_event, filename) => {
        if (stopped || !filename) return;
        const rel = String(filename).split(sep).join("/");
        if (!rel.endsWith(".jsonl") || rel.endsWith(TRANSCRIPT_SIDECAR_SUFFIX)) return;
        flushRel(rel);
      });
    } catch {
      /* watch unavailable; turn/idle still flush */
    }
  }

  const pollMs = opts.pollMs ?? 0;
  const timer = pollMs > 0 ? setInterval(flush, pollMs) : undefined;
  if (timer && typeof timer === "object" && "unref" in timer) timer.unref();

  return {
    flush,
    onTurnStart,
    onTurnComplete,
    stop() {
      if (stopped) return;
      stopped = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (timer) clearInterval(timer);
      try {
        watcher?.close();
      } catch {
        /* already closed */
      }
    },
  };
}

export { listProjectJsonl } from "./transcript-mirror.js";
