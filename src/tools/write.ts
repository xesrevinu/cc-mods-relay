import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { asString, mapPath } from "./paths.js";
import { structuredPatch } from "./patch.js";

export async function writeTool(cwd: string, tuiRoot: string | undefined, input: Record<string, unknown>, extraDirs: string[] = []) {
  const path = mapPath(cwd, tuiRoot, asString(input.file_path), extraDirs);
  const content = asString(input.content);
  const existed = await Bun.file(path).exists();
  const originalFile = existed ? await Bun.file(path).text() : null;
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, content);
  return {
    type: existed ? "update" as const : "create" as const,
    filePath: path,
    content,
    structuredPatch: structuredPatch(originalFile ?? "", content),
    originalFile,
  };
}
