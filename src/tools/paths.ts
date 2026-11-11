import { isAbsolute, relative, resolve } from "node:path";

export function inside(root: string, abs: string): string {
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Path is outside ${root}`);
  return abs;
}

function under(root: string, abs: string): string | undefined {
  try {
    return inside(root, abs);
  } catch {
    return undefined;
  }
}

export function mapPath(cwd: string, tuiRoot: string | undefined, path: string, extraDirs: string[] = []): string {
  const root = tuiRoot ? resolve(tuiRoot) : cwd;
  const abs = isAbsolute(path) ? resolve(path) : resolve(root, path);
  if (tuiRoot) {
    const fromTui = relative(root, abs);
    if (fromTui === "") return inside(cwd, cwd);
    if (!fromTui.startsWith("..") && !isAbsolute(fromTui)) return inside(cwd, resolve(cwd, fromTui));
  }
  const hit = under(cwd, abs);
  if (hit) return hit;
  for (const extra of extraDirs) {
    const mapped = under(resolve(extra), abs);
    if (mapped) return mapped;
  }
  return inside(cwd, abs);
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
