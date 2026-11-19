import type { FileReadOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { compressImage, IMAGE_MAX_SOURCE_BYTES, type ImageMime } from "./image-compress.js";
import { asBool, asNumber, asString, mapReadPath } from "./paths.js";
import { ioMessage } from "./runtime.js";

const IMAGES: Record<string, ImageMime> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const LINE_CHAR_CAP = 2000;
const DEFAULT_LIMIT = 2000;
const LARGE_LIMIT = 100_000;
const STREAM_PAGE_THRESHOLD_BYTES = 256 * 1024;
const EXACT_LINE_COUNT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_PDF_BYTES = Math.floor(2.5 * 1024 * 1024);
/**
 * Mods cannot join hook `{ result }` parts past ~4 MiB (and JSON escaping of
 * quotes/backslashes/newlines expands UTF-8 text). 1.5 MiB stays safely below.
 */
export const READ_CONTENT_BYTE_CAP = 1_500_000;

function clipLine(line: string): string {
  return line.length > LINE_CHAR_CAP ? `${line.slice(0, LINE_CHAR_CAP)}…` : line;
}

async function readPagedStream(
  file: ReturnType<typeof Bun.file>,
  startLine: number,
  limit: number,
  countExactTotal: boolean,
): Promise<{ lines: string[]; totalLines: number; exactTotal: boolean }> {
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  const endLine = limit <= 0 ? startLine - 1 : startLine + limit - 1;
  const collected: string[] = [];
  let lineNo = 0;
  let pending = "";
  let pastWindow = false;
  let stoppedEarly = false;
  let lastByte = -1;

  const pushLine = (line: string): boolean => {
    lineNo += 1;
    if (lineNo >= startLine && lineNo <= endLine) {
      collected.push(clipLine(line));
    } else if (lineNo > endLine) {
      return true;
    }
    return false;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      lastByte = value[value.length - 1]!;
      if (pastWindow) {
        for (let i = 0; i < value.length; i++) {
          if (value[i] === 0x0a) lineNo += 1;
        }
        continue;
      }
      pending += decoder.decode(value, { stream: true });
      let start = 0;
      for (;;) {
        const nl = pending.indexOf("\n", start);
        if (nl < 0) break;
        const line = pending.slice(start, nl);
        start = nl + 1;
        if (pushLine(line)) {
          if (countExactTotal) {
            pastWindow = true;
            // Count any remaining newlines already decoded into `pending`.
            for (let k = start; k < pending.length; k++) {
              if (pending.charCodeAt(k) === 10) lineNo += 1;
            }
            pending = "";
            start = 0;
          } else {
            stoppedEarly = true;
          }
          break;
        }
      }
      if (!pastWindow) pending = pending.slice(start);
      if (stoppedEarly) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    if (!stoppedEarly) {
      if (pastWindow) {
        if (lastByte !== -1 && lastByte !== 0x0a) lineNo += 1;
      } else {
        pending += decoder.decode();
        if (pending.length > 0) pushLine(pending);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { lines: collected, totalLines: lineNo, exactTotal: !stoppedEarly };
}

function takeUtf8Budget(lines: string[], maxBytes: number): { lines: string[]; truncated: boolean } {
  const out: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, "utf8");
    const extra = out.length === 0 ? lineBytes : 1 + lineBytes;
    if (out.length === 0 && extra > maxBytes) {
      let keep = line;
      while (keep.length > 1 && Buffer.byteLength(`${keep.slice(0, -1)}…`, "utf8") > maxBytes) {
        keep = keep.slice(0, Math.max(1, keep.length - 64));
      }
      return { lines: [`${keep.slice(0, -1)}…`], truncated: true };
    }
    if (bytes + extra > maxBytes) return { lines: out, truncated: true };
    bytes += extra;
    out.push(line);
  }
  return { lines: out, truncated: false };
}

function sniffImage(buf: Uint8Array): ImageMime | undefined {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return "image/webp";
  return undefined;
}

function isProbablyBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export async function readTool(cwd: string, tuiRoot: string | undefined, input: Record<string, unknown>, extraDirs: string[] = [], project?: string): Promise<FileReadOutput> {
  const path = mapReadPath(cwd, tuiRoot, asString(input.file_path), extraDirs, project);
  const file = Bun.file(path);
  let info: { isDirectory(): boolean; size: number };
  try {
    info = await file.stat();
  } catch (error) {
    throw ioMessage(path, error, `File does not exist: ${path}`);
  }
  if (info.isDirectory()) throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);

  const ext = path.match(/\.([^./]+)$/)?.[1]?.toLowerCase() ?? "";
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer().catch(() => new ArrayBuffer(0)));
  const mime = IMAGES[ext] ?? sniffImage(head);

  if (mime) {
    if (info.size > IMAGE_MAX_SOURCE_BYTES) {
      throw new Error(`Image is ${info.size} bytes; the local executor limit is ${IMAGE_MAX_SOURCE_BYTES} bytes`);
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const compressed = await compressImage(buf, mime);
    return {
      type: "image" as const,
      file: {
        base64: compressed.bytes.toString("base64"),
        type: compressed.mime,
        originalSize: compressed.originalSize,
        dimensions: compressed.dimensions,
      },
    };
  }
  if (ext === "pdf") {
    if (info.size > MAX_PDF_BYTES) throw new Error("PDF is larger than 2.5 MiB; page extraction is not supported on the local executor");
    const buf = Buffer.from(await file.arrayBuffer());
    return {
      type: "pdf" as const,
      file: { filePath: path, base64: buf.toString("base64"), originalSize: buf.byteLength },
    };
  }
  if (ext === "ipynb") {
    try {
      const notebook = JSON.parse(await file.text()) as { cells?: unknown[] };
      return { type: "notebook" as const, file: { filePath: path, cells: notebook.cells ?? [] } };
    } catch {
    }
  }

  const sample = new Uint8Array(await file.slice(0, 8000).arrayBuffer().catch(() => new ArrayBuffer(0)));
  if (isProbablyBinary(sample)) throw new Error(`This is a binary file and cannot be read as text: ${path}`);

  const startLine = Math.max(1, asNumber(input.offset) ?? 1);
  const allowLarge = asBool(input.allow_large) === true;
  const reqLimit = asNumber(input.limit);
  const limit = reqLimit ?? (allowLarge ? LARGE_LIMIT : DEFAULT_LIMIT);
  const wholeFile = asNumber(input.offset) === undefined && reqLimit === undefined && !allowLarge;
  if (info.size > STREAM_PAGE_THRESHOLD_BYTES && !allowLarge) {
    const paged = await readPagedStream(file, startLine, Math.max(0, limit), info.size <= EXACT_LINE_COUNT_MAX_BYTES);
    if (paged.exactTotal && startLine > paged.totalLines) {
      return {
        type: "text" as const,
        file: { filePath: path, content: "", numLines: 0, startLine, totalLines: paged.totalLines },
      };
    }
    const capped = takeUtf8Budget(paged.lines, READ_CONTENT_BYTE_CAP);
    const truncatedByTokenCap =
      capped.truncated || (wholeFile && startLine === 1 && (!paged.exactTotal || paged.lines.length < paged.totalLines));
    return {
      type: "text" as const,
      file: {
        filePath: path,
        content: capped.lines.join("\n"),
        numLines: capped.lines.length,
        startLine,
        totalLines: paged.totalLines,
        ...(truncatedByTokenCap ? { truncatedByTokenCap: true as const } : {}),
      },
    };
  }

  const raw = await file.text();
  const lines = raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (startLine > lines.length) {
    return {
      type: "text" as const,
      file: { filePath: path, content: "", numLines: 0, startLine, totalLines: lines.length },
    };
  }
  const slice = lines.slice(startLine - 1, startLine - 1 + Math.max(0, limit)).map(clipLine);
  const capped = takeUtf8Budget(slice, READ_CONTENT_BYTE_CAP);
  const truncatedByTokenCap =
    capped.truncated || (wholeFile && startLine === 1 && slice.length < lines.length);
  return {
    type: "text" as const,
    file: {
      filePath: path,
      content: capped.lines.join("\n"),
      numLines: capped.lines.length,
      startLine,
      totalLines: lines.length,
      ...(truncatedByTokenCap ? { truncatedByTokenCap: true as const } : {}),
    },
  };
}
