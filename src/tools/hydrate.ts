import { createHash } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { asString, mapPath } from "./paths.js";

export function miniRelative(cwd: string, abs: string, extraDirs: string[] = []): string {
  const fromCwd = relative(cwd, abs);
  if (fromCwd === "") return basename(abs) || "file";
  if (!fromCwd.startsWith("..") && !isAbsolute(fromCwd)) return fromCwd;
  for (const extra of extraDirs) {
    const fromExtra = relative(resolve(extra), abs);
    if (fromExtra === "") return join(".extra", extraTag(extra), basename(extra));
    if (!fromExtra.startsWith("..") && !isAbsolute(fromExtra)) {
      return join(".extra", extraTag(extra), fromExtra);
    }
  }
  return join(".hydrate", basename(abs));
}

function extraTag(extra: string): string {
  return createHash("sha256").update(extra).digest("hex").slice(0, 8);
}

export async function hydrateTool(
  cwd: string,
  tuiRoot: string | undefined,
  input: Record<string, unknown>,
  extraDirs: string[] = [],
) {
  const abs = mapPath(cwd, tuiRoot, asString(input.file_path), extraDirs);
  const file = Bun.file(abs);
  if (!(await file.exists())) throw new Error(`File does not exist: ${abs}`);
  const buf = Buffer.from(await file.arrayBuffer());
  return {
    path: abs,
    relative: miniRelative(cwd, abs, extraDirs),
    base64: buf.toString("base64"),
    bytes: buf.byteLength,
  };
}
