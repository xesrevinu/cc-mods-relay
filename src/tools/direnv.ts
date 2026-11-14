/** Apply `direnv export json` onto a spawn env so local Bash sees `.envrc` / nix flakes. */

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

/**
 * Non-interactive `bash -c` does not run direnv's shell hook. Export against
 * `cwd` and merge so the local tool socket matches an interactive project shell.
 * Failure (missing binary, blocked `.envrc`, bad JSON) leaves `base` unchanged.
 */
export async function withDirenv(
  cwd: string,
  base: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  if (process.platform === "win32") return { ...base };
  const direnv = Bun.which("direnv", { PATH: base.PATH });
  if (!direnv) return { ...base };
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
    if (code !== 0) return { ...base };
    const text = stdout.trim();
    if (!text) return { ...base };
    return applyDirenvDump(base, JSON.parse(text));
  } catch {
    return { ...base };
  }
}
