import { $ } from "bun";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, release, type } from "node:os";
import { basename, dirname, join } from "node:path";

const run = (cmd: ReturnType<typeof $>, cwd: string) =>
  cmd.cwd(cwd).quiet().nothrow().text().then((s) => s.trim());

/** Instruction files Claude Code would load for this directory: user, then every ancestor, nearest last. */
async function memory(cwd: string): Promise<string> {
  const dirs: string[] = [];
  for (let d = cwd; ; d = dirname(d)) {
    dirs.unshift(d);
    if (d === dirname(d)) break;
  }
  const candidates = [
    join(homedir(), ".claude", "CLAUDE.md"),
    ...dirs.flatMap((d) => [
      join(d, "AGENTS.md"),
      join(d, "CLAUDE.md"),
      join(d, ".claude", "CLAUDE.md"),
      join(d, "CLAUDE.local.md"),
    ]),
  ];
  const found: string[] = [];
  for (const path of new Set(candidates)) {
    const file = Bun.file(path);
    if (await file.exists()) found.push(`Contents of ${path}:\n\n${(await file.text()).trim()}`);
  }
  if (!found.length) return "";
  return (
    `\n\n# claudeMd\nCodebase and user instructions are shown below. Be sure to adhere to these instructions. ` +
    `IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\n` +
    found.join("\n\n")
  );
}

async function git(cwd: string): Promise<string> {
  const branch = await run($`git rev-parse --abbrev-ref HEAD`, cwd);
  if (!branch) return "";
  const status = (await run($`git status --short`, cwd)).split("\n").slice(0, 40).join("\n");
  const log = await run($`git log --oneline -5`, cwd);
  return (
    `\n\n# gitStatus\nThis is the git status of the working directory at the start of the conversation.\n` +
    `Current branch: ${branch}\n\nStatus:\n${status || "(clean)"}\n\nRecent commits:\n${log}`
  );
}

/**
 * Appended onto the TUI system prompt so file and shell tools use the client
 * working directory. Claude Code also prints its own Environment block for the
 * host session cwd (`~/Workspace/<relative path>`).
 */
export async function buildEnvironmentAppend(cwd: string, extraDirs: string[] = []): Promise<string> {
  const [gitStatus, claudeMd] = await Promise.all([git(cwd), memory(cwd)]);
  const extra = extraDirsLine(extraDirs);
  const shell = process.platform === "win32" ? "PowerShell" : basename(process.env.SHELL || "bash");
  return `# Environment
File and shell tools in this session use the working directory below.
 - Working directory: ${cwd}${extra}
 - Is a git repository: ${gitStatus ? "yes" : "no"}
 - Platform: ${process.platform}
 - OS version: ${type()} ${release()}
 - Shell: ${shell}${gitStatus}${claudeMd}
`;
}

export const ENVIRONMENT_FILE = "environment.txt";

/** Sidecar next to the plugin. Mods cats this at session.start instead of printenv. */
export const EXTRA_DIRS_FILE = "extra-dirs.json";

export function workspaceOnClient(opts: {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean } | null;
  environmentFile?: boolean;
}): boolean {
  if (opts.environmentFile) return true;
  return opts.fs?.readTextFile === true && opts.fs?.writeTextFile === true;
}

/** Host session cwd when the workspace lives on the ACP client. */
export function resolveTuiCwd(
  requested: string,
  onClient: boolean,
  here: string = process.cwd(),
): string {
  return onClient ? here : requested;
}

export function extraDirsLine(dirs: string[]): string {
  if (!dirs.length) return "";
  return `\n - Additional working directories: ${dirs.join(", ")}`;
}

/**
 * Each local project maps to a new folder under ~/Workspace on the host.
 * Mark that folder trusted in the host Claude config before the TUI starts.
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

/**
 * Extra dirs go in a sidecar (Mods cats it). Keep a Mac-baked environment.txt
 * if present — rewriting on Mini would drop the git/CLAUDE.md snapshot.
 */
export async function writeSessionMount(pluginDir: string, cwd: string, extraDirs: string[]): Promise<void> {
  writeFileSync(join(pluginDir, EXTRA_DIRS_FILE), JSON.stringify(extraDirs));
  const envPath = join(pluginDir, ENVIRONMENT_FILE);
  if (existsSync(envPath)) {
    if (!extraDirs.length) return;
    const current = readFileSync(envPath, "utf8");
    const extra = extraDirsLine(extraDirs);
    if (!current.includes(extra.trim())) writeFileSync(envPath, `${current.trimEnd()}${extra}\n`);
    return;
  }
  if (extraDirs.length) writeFileSync(envPath, await buildEnvironmentAppend(cwd, extraDirs));
}
