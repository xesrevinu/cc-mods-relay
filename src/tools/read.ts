import { compressImage, IMAGE_MAX_SOURCE_BYTES, type ImageMime } from "./image-compress.js";
import { asBool, asNumber, asString, mapPath } from "./paths.js";

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
const MAX_PDF_BYTES = 10 * 1024 * 1024;

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

function ioMessage(path: string, error: unknown, missing: string): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return new Error(missing);
  if (code === "EACCES" || code === "EPERM") return new Error(`Permission denied: ${path}`);
  return error instanceof Error ? error : new Error(String(error));
}

export async function readTool(cwd: string, tuiRoot: string | undefined, input: Record<string, unknown>, extraDirs: string[] = []) {
  const path = mapPath(cwd, tuiRoot, asString(input.file_path), extraDirs);
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
    if (info.size > MAX_PDF_BYTES) throw new Error("PDF is larger than 10 MiB; page extraction is not supported on the local executor");
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

  const raw = await file.text();
  const lines = raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const startLine = Math.max(1, asNumber(input.offset) ?? 1);
  const allowLarge = asBool(input.allow_large) === true;
  const limit = asNumber(input.limit) ?? (allowLarge ? LARGE_LIMIT : DEFAULT_LIMIT);
  if (startLine > lines.length) {
    return {
      type: "text" as const,
      file: { filePath: path, content: "", numLines: 0, startLine, totalLines: lines.length },
    };
  }
  const slice = lines.slice(startLine - 1, startLine - 1 + Math.max(0, limit)).map((line) =>
    line.length > LINE_CHAR_CAP ? `${line.slice(0, LINE_CHAR_CAP)}…` : line,
  );
  return {
    type: "text" as const,
    file: {
      filePath: path,
      content: slice.join("\n"),
      numLines: slice.length,
      startLine,
      totalLines: lines.length,
    },
  };
}
