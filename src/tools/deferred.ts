import { asString, mapPath } from "./paths.js";

export async function sendFileTool(
  cwd: string,
  tuiRoot: string | undefined,
  input: Record<string, unknown>,
  extraDirs: string[] = [],
  project?: string,
): Promise<Record<string, unknown>> {
  const path = mapPath(cwd, tuiRoot, asString(input.file_path) || asString(input.path), extraDirs, project);
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`File does not exist: ${path}`);
  const stat = await file.stat();
  if (stat.isDirectory()) throw new Error(`File is a directory: ${path}`);
  return { filePath: path, bytes: stat.size };
}
