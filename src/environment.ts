import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Sidecar next to the plugin. Mods cats this at session.start instead of printenv. */
export const EXTRA_DIRS_FILE = "extra-dirs.json";

export function workspaceOnClient(opts: {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean } | null;
}): boolean {
  return opts.fs?.readTextFile === true && opts.fs?.writeTextFile === true;
}

/** Absolute path with no shell metacharacters. Need not exist on this host. */
export function isSafeAbsPath(p: string): boolean {
  return p.startsWith("/") && !/["$`\n\r]/.test(p);
}

/**
 * Client pwd stamped at agent launch. ACP `session/new.cwd` is only a fallback
 * when the launcher did not pass `--cwd`.
 */
export function sessionClientCwd(launchCwd: string | undefined, requested: string): string {
  if (launchCwd && isSafeAbsPath(launchCwd)) return launchCwd;
  return requested;
}

/**
 * Host directory the TUI process cds into. Prefer the client pwd when that
 * directory exists here (hostTuiRoot mkdir's it) so Claude Code's Environment
 * is the client path, not the TUI host `$HOME`.
 */
export function resolveTuiCwd(
  requested: string,
  onClient: boolean,
  here: string = process.cwd(),
): string {
  if (!onClient) return requested;
  if (requested && existsSync(requested)) return requested;
  return here;
}

/**
 * Mark the TUI session cwd trusted in the host Claude config before the TUI starts.
 */
export function trustTuiCwd(cwd: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): void {
  if (!cwd.startsWith("/") || /[\n\r]/.test(cwd)) return;
  const files = [
    env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : "",
    join(home, ".claude.json"),
  ].filter(Boolean);
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as {
        projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
      };
      const projects = raw.projects ?? {};
      const prev = projects[cwd] ?? {};
      if (prev.hasTrustDialogAccepted === true) continue;
      raw.projects = { ...projects, [cwd]: { ...prev, hasTrustDialogAccepted: true } };
      writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
    } catch {
      /* leave the file alone if it is not JSON */
    }
  }
}

/** Extra dirs go in a sidecar (Mods cats it). Prompt listing uses Claude Code `--add-dir`. */
export async function writeSessionMount(pluginDir: string, extraDirs: string[]): Promise<void> {
  writeFileSync(join(pluginDir, EXTRA_DIRS_FILE), JSON.stringify(extraDirs));
}

/** Keys Claude Code stores after the first Code Mode confirmation dialog. */
export const CODE_MODE_CAVEAT_KEYS = [
  "codeModeCaveatsAcceptedV1",
  "codeModeAutoModeCaveatAcceptedV1",
] as const;

function writeClaudeJson(path: string, body: string): void {
  const write = (): void => {
    writeFileSync(path, body);
    chmodSync(path, 0o600);
  };
  try {
    write();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw error;
    chmodSync(path, 0o600);
    write();
  }
}

/**
 * Skip the first-run Code Mode confirmation (and the TUI restart it triggers)
 * by writing the caveat flags Claude Code keeps in `.claude.json`.
 */
export function acceptCodeModeCaveats(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): void {
  const files = env.CLAUDE_CONFIG_DIR
    ? [join(env.CLAUDE_CONFIG_DIR, ".claude.json")]
    : [join(home, ".claude.json")];
  for (const file of files) {
    try {
      const raw = (
        existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}
      ) as Record<string, unknown>;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const already = CODE_MODE_CAVEAT_KEYS.every((key) => raw[key] === true);
      if (already) continue;
      for (const key of CODE_MODE_CAVEAT_KEYS) raw[key] = true;
      writeClaudeJson(file, `${JSON.stringify(raw, null, 2)}\n`);
    } catch {
      /* leave the file alone if it is not JSON */
    }
  }
}
