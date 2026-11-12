import { closeSync, globSync, openSync, readFileSync, readSync, statSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function transcriptGlob(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(claudeConfigDir(env), "projects", "**", `${sessionId}.jsonl`);
}

export function findTranscript(sessionId: string): string[] {
  return globSync(transcriptGlob(sessionId));
}

export const FILE_DISCOVERY_WATCHDOG_MS = 2000;

export const DEFAULT_POLL_INTERVAL_MS = 50;

export interface LocateOptions {
  watchdogMs?: number;
  pollIntervalMs?: number;
  glob?: (sessionId: string) => string[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

function defaultNow(): number {
  return performance.now();
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function locateTranscript(
  sessionId: string,
  opts: LocateOptions = {},
): Promise<{ transcriptPath: string }> {
  const watchdogMs = opts.watchdogMs ?? FILE_DISCOVERY_WATCHDOG_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const glob = opts.glob ?? findTranscript;
  const now = opts.now ?? defaultNow;
  const sleep = opts.sleep ?? defaultSleep;

  const start = now();
  for (;;) {
    const matches = glob(sessionId);

    if (opts.signal?.aborted) {
      throw (
        opts.signal.reason ??
        Object.assign(new Error("transcript discovery aborted"), { name: "AbortError" })
      );
    }

    if (matches.length > 1) {
      throw new Error(
        `Multiple transcripts matched sessionId "${sessionId}" — refusing to pick one. ` +
          `Matched ${matches.length} paths:\n${matches.map((p) => `  - ${p}`).join("\n")}`,
      );
    }

    if (matches.length === 1) {
      return { transcriptPath: matches[0] };
    }

    const elapsed = now() - start;
    if (elapsed >= watchdogMs) {
      throw new Error(
        `Transcript not found for sessionId "${sessionId}" after ${Math.round(elapsed)}ms ` +
          `(file-discovery watchdog ${watchdogMs}ms). Globbed: ${transcriptGlob(sessionId)}`,
      );
    }

    await sleep(pollIntervalMs);
  }
}

interface TranscriptRecord {
  cwd?: unknown;
  [key: string]: unknown;
}

export function readCwdFromInside(transcriptPath: string): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(transcriptPath, "utf8");
  } catch {
    return undefined;
  }

  const newlineIdx = contents.lastIndexOf("\n");
  if (newlineIdx < 0) return undefined;
  const completeRegion = contents.slice(0, newlineIdx);

  for (const line of completeRegion.split("\n")) {
    if (line.length === 0) continue;
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch {
      continue;
    }
    if (typeof record.cwd === "string" && record.cwd.length > 0) {
      return record.cwd;
    }
  }
  return undefined;
}

export async function resolveWatchTarget(
  sessionId: string,
  opts: LocateOptions = {},
): Promise<{ transcriptPath: string; cwd: string | undefined }> {
  const { transcriptPath } = await locateTranscript(sessionId, opts);
  const cwd = readCwdFromInside(transcriptPath);
  return { transcriptPath, cwd };
}

export type RecordHandler = (record: unknown) => void;

export interface LineReader {
  push(chunk: string): void;
  readonly residue: string;
}

function parseCompleteLine(line: string, onRecord: RecordHandler): void {
  if (line.length === 0) return;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  onRecord(record);
}

export function createLineReader(onRecord: RecordHandler): LineReader {
  let residue = "";
  return {
    push(chunk: string): void {
      residue += chunk;
      const segments = residue.split("\n");
      residue = segments.pop() ?? "";
      for (const segment of segments) {
        parseCompleteLine(segment, onRecord);
      }
    },
    get residue(): string {
      return residue;
    },
  };
}

export function feedChunks(chunks: Iterable<string>, onRecord: RecordHandler): void {
  const reader = createLineReader(onRecord);
  for (const chunk of chunks) {
    reader.push(chunk);
  }
  parseCompleteLine(reader.residue, onRecord);
}

export interface TranscriptTail {
  stop(): void;
}

export interface TailOptions {
  onRecord: RecordHandler;
  watch?: (path: string, onChange: () => void) => { close(): void };
  readSlice?: (path: string, fromByte: number) => string;
  fileSize?: (path: string) => number;
}

function defaultWatch(path: string, onChange: () => void): { close(): void } {
  const watcher = watch(path, () => onChange());
  return { close: () => watcher.close() };
}

function defaultFileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function defaultReadSlice(path: string, fromByte: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = statSync(path).size;
    if (size <= fromByte) return "";
    const length = size - fromByte;
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, fromByte + read);
      if (n <= 0) break;
      read += n;
    }
    return new StringDecoder("utf8").write(buf.subarray(0, read));
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
      }
    }
  }
}

export function readFileTail(path: string, maxBytes = 512 * 1024): string {
  try {
    const size = statSync(path).size;
    const from = Math.max(0, size - maxBytes);
    return defaultReadSlice(path, from);
  } catch {
    return "";
  }
}

export function tailTranscript(path: string, opts: TailOptions): TranscriptTail {
  const watchFn = opts.watch ?? defaultWatch;
  const readSlice = opts.readSlice ?? defaultReadSlice;
  const fileSize = opts.fileSize ?? defaultFileSize;

  const reader = createLineReader(opts.onRecord);
  let offset = fileSize(path);
  let stopped = false;

  const onChange = (): void => {
    if (stopped) return;
    const size = fileSize(path);
    if (size < offset) offset = 0;
    if (size <= offset) return;
    const slice = readSlice(path, offset);
    if (slice.length === 0) return;
    offset += Buffer.byteLength(slice, "utf8");
    reader.push(slice);
  };

  const subscription = watchFn(path, onChange);

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      try {
        subscription.close();
      } catch {
      }
    },
  };
}

export interface JsonlEvent {
  uuid: string;
  type: string;
  timestamp?: string;
  sessionId?: string;
  message: unknown;
  parentToolUseId?: string | null;
  userType?: "external";
  parentUuid?: string | null;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  isSidechain?: boolean;
  entrypoint?: string;
  requestId?: string;
  promptId?: string;
  toolUseResult?: unknown;
  permissionMode?: string;
}

export interface ProjectOptions {
  imageSkipBytes?: number;
}

export const DEFAULT_IMAGE_SKIP_BYTES = 64 * 1024;

const SKIPPED_IMAGE_DATA = "";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function carryIfPresent(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  if (source[key] !== undefined) target[key] = source[key];
}

export function stripHeavyImages(
  message: unknown,
  imageSkipBytes: number = DEFAULT_IMAGE_SKIP_BYTES,
): unknown {
  if (!isObject(message)) return message;
  const content = message.content;
  if (!Array.isArray(content)) return message;

  let anyStripped = false;
  const newContent = content.map((block) => {
    if (!isObject(block) || block.type !== "image") return block;
    const source = block.source;
    if (!isObject(source) || source.type !== "base64") return block;
    const data = source.data;
    if (typeof data !== "string") return block;
    const bytes = Buffer.byteLength(data, "utf8");
    if (bytes <= imageSkipBytes) return block;

    anyStripped = true;
    return {
      ...block,
      source: {
        ...source,
        data: SKIPPED_IMAGE_DATA,
        skipped: true,
        bytes,
      },
    };
  });

  if (!anyStripped) return message;
  return { ...message, content: newContent };
}

export function projectEvent(message: unknown, opts: ProjectOptions = {}): JsonlEvent {
  const imageSkipBytes = opts.imageSkipBytes ?? DEFAULT_IMAGE_SKIP_BYTES;
  const src: Record<string, unknown> = isObject(message) ? message : {};

  const projectedMessage = stripHeavyImages(src.message, imageSkipBytes);

  const event: JsonlEvent = {
    uuid: typeof src.uuid === "string" ? src.uuid : "",
    type: typeof src.type === "string" ? src.type : "",
    message: projectedMessage,
    userType: "external",
  };

  if (typeof src.timestamp === "string") event.timestamp = src.timestamp;
  if (typeof src.session_id === "string") event.sessionId = src.session_id;
  if (src.parent_tool_use_id !== undefined) {
    event.parentToolUseId = src.parent_tool_use_id as string | null;
  }

  const eventRec = event as unknown as Record<string, unknown>;
  for (const key of [
    "parentUuid",
    "cwd",
    "gitBranch",
    "version",
    "isSidechain",
    "entrypoint",
    "requestId",
    "promptId",
    "toolUseResult",
    "permissionMode",
  ]) {
    carryIfPresent(eventRec, src, key);
  }

  return event;
}
