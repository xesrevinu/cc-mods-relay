import { join } from "node:path";
import { asString, mapPath } from "./paths.js";

const LIMIT = 100;
const SKIP = /(^|[\\/])(\.git|node_modules)[\\/]/;

export async function globTool(cwd: string, tuiRoot: string | undefined, input: Record<string, unknown>, extraDirs: string[] = []) {
  const started = performance.now();
  const pattern = asString(input.pattern);
  const root = mapPath(cwd, tuiRoot, asString(input.path, ".") || ".", extraDirs);
  const skip = !/\.git|node_modules/.test(pattern);
  const files: string[] = [];
  for await (const file of new Bun.Glob(pattern).scan({ cwd: root, dot: true, onlyFiles: true })) {
    if (!skip || !SKIP.test(file)) files.push(join(root, file));
  }
  const dated = await Promise.all(files.map(async (f) => [f, (await Bun.file(f).stat().catch(() => null))?.mtime.getTime() ?? 0] as const));
  dated.sort((a, b) => b[1] - a[1]);
  const filenames = dated.slice(0, LIMIT).map(([f]) => f);
  return {
    durationMs: Math.round(performance.now() - started),
    numFiles: filenames.length,
    filenames,
    truncated: files.length > LIMIT,
    totalMatches: files.length,
    countIsComplete: true,
  };
}
