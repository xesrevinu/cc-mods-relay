import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { persistCwd, resetSessionCwd } from "./bash.js";
import { asString, mapCwd, mergeRoots } from "./paths.js";

type ToolFrame = {
  callId?: string;
  sessionId?: string;
  cwd?: string;
  tuiRoot?: string;
  extraDirs?: string[];
};

async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export async function enterWorktreeTool(
  workspace: string,
  frame: ToolFrame,
  input: Record<string, unknown>,
  extraDirs: string[] = [],
): Promise<Record<string, unknown>> {
  const sessionId = frame.sessionId || "";
  const roots = mergeRoots(extraDirs);
  const named = asString(input.path) || asString(input.directory);
  if (named) {
    const abs = mapCwd(workspace, frame.tuiRoot, named, roots, workspace);
    persistCwd(workspace, sessionId, abs, roots);
    return { path: abs, cwd: abs };
  }
  const name = asString(input.name) || asString(input.branch) || `wt-${Date.now()}`;
  const dest = join(workspace, ".claude", "worktrees", name);
  mkdirSync(join(workspace, ".claude", "worktrees"), { recursive: true });
  const branch = asString(input.branch);
  const args = branch ? ["worktree", "add", "-b", branch, dest] : ["worktree", "add", "--detach", dest];
  const ran = await git(workspace, args);
  if (ran.code !== 0) {
    const listed = await git(workspace, ["worktree", "list", "--porcelain"]);
    throw new Error((ran.stderr || ran.stdout || listed.stderr || "git worktree add failed").trim());
  }
  persistCwd(workspace, sessionId, dest, roots);
  return { path: dest, cwd: dest, created: true };
}

export function exitWorktreeTool(workspace: string, frame: ToolFrame): Record<string, unknown> {
  resetSessionCwd(frame.sessionId || "");
  return { cwd: workspace, path: workspace };
}