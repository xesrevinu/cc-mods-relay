/** Apply `direnv export json` onto a spawn env so local Bash sees `.envrc` / nix flakes. */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

type DirenvDump = Record<string, string | null>;
const CACHE_MAX = 64;
const dumpCache = new Map<string, DirenvDump | null>();

export function spawnEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Merge a direnv JSON dump (string values set, `null` unsets) onto `base`. */
export function applyDirenvDump(base: NodeJS.ProcessEnv, dump: unknown): NodeJS.ProcessEnv {
  if (!dump || typeof dump !== "object" || Array.isArray(dump)) return { ...base };
  const env = { ...base };
  for (const [key, value] of Object.entries(dump as Record<string, unknown>)) {
    if (value === null) delete env[key];
    else if (typeof value === "string") env[key] = value;
  }
  return env;
}

function statMtime(path: string): string {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "0";
  }
}

function findNearestEnvrc(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, ".envrc");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function direnvAllowMtime(base: NodeJS.ProcessEnv): string {
  const dataHome = base.XDG_DATA_HOME || join(base.HOME || homedir(), ".local", "share");
  return statMtime(join(dataHome, "direnv", "allow"));
}

function rememberDump(key: string, dump: DirenvDump | null): void {
  if (dumpCache.size >= CACHE_MAX) {
    const oldest = dumpCache.keys().next().value;
    if (oldest !== undefined) dumpCache.delete(oldest);
  }
  dumpCache.set(key, dump);
}

export function clearDirenvCacheForTests(): void {
  dumpCache.clear();
}

/**
 * Non-interactive `bash -c` does not run direnv's shell hook. Export against
 * `cwd` and merge so the local tool socket matches an interactive project shell.
 * Skips spawning when no ancestor `.envrc` exists, and caches by `.envrc` /
 * `.env` / `direnv/allow` mtime so unchanged repos avoid repeated subprocesses.
 */
export async function withDirenv(
  cwd: string,
  base: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  if (process.platform === "win32") return { ...base };
  const envrc = findNearestEnvrc(cwd);
  if (!envrc) return { ...base };
  const direnv = Bun.which("direnv", { PATH: base.PATH });
  if (!direnv) return { ...base };

  const cacheKey = !base.DIRENV_DIR
    ? `${envrc}|${statMtime(envrc)}|${statMtime(join(dirname(envrc), ".env"))}|${direnvAllowMtime(base)}|${base.PATH ?? ""}`
    : undefined;
  if (cacheKey && dumpCache.has(cacheKey)) {
    const cached = dumpCache.get(cacheKey);
    return cached ? applyDirenvDump(base, cached) : { ...base };
  }

  try {
    const proc = Bun.spawn([direnv, "export", "json"], {
      cwd,
      env: spawnEnv(base),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    if (code !== 0) {
      if (cacheKey) rememberDump(cacheKey, null);
      return { ...base };
    }
    const text = stdout.trim();
    if (!text) {
      if (cacheKey) rememberDump(cacheKey, null);
      return { ...base };
    }
    const parsed = JSON.parse(text) as DirenvDump;
    if (cacheKey && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      rememberDump(cacheKey, parsed);
    }
    return applyDirenvDump(base, parsed);
  } catch {
    return { ...base };
  }
}
