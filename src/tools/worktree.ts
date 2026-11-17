import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { persistCwd, resetSessionCwd, sessionCwd } from "./bash.js";
import { asBool, asString, mapCwd, mergeRoots } from "./paths.js";
import type { ToolFrame } from "./runtime.js";

type State = { originalCwd: string; worktreePath: string; worktreeBranch?: string; created: boolean };

const states = new Map<string, State>();

async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function real(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

function listedWorktrees(porcelain: string): { path: string; branch?: string }[] {
  const out: { path: string; branch?: string }[] = [];
  let current: { path: string; branch?: string } | undefined;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) out.push(current);
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "" && current) {
      out.push(current);
      current = undefined;
    }
  }
  if (current) out.push(current);
  return out;
}

function nameOk(name: string): boolean {
  return name.length > 0 && name.length <= 64 && name.split("/").every((part) => /^[A-Za-z0-9._-]+$/.test(part));
}

export async function enterWorktreeTool(
  workspace: string,
  frame: ToolFrame,
  input: Record<string, unknown>,
  extraDirs: string[] = [],
): Promise<Record<string, unknown>> {
  const sessionId = frame.sessionId || "";
  const roots = mergeRoots(extraDirs);
  const named = asString(input.name);
  const pathIn = asString(input.path);
  if (named && pathIn) throw new Error("name and path are mutually exclusive");

  const listed = await git(workspace, ["worktree", "list", "--porcelain"]);
  const trees = listed.code === 0 ? listedWorktrees(listed.stdout) : [];

  if (pathIn) {
    const abs = real(mapCwd(workspace, frame.tuiRoot, pathIn, roots, workspace));
    const hit = trees.find((t) => real(t.path) === abs);
    if (!hit) throw new Error(`Path is not in git worktree list: ${abs}`);
    persistCwd(workspace, sessionId, abs, roots);
    states.set(sessionId, { originalCwd: workspace, worktreePath: abs, worktreeBranch: hit.branch, created: false });
    return {
      worktreePath: abs,
      worktreeBranch: hit.branch,
      message: `Entered worktree ${abs}`,
    };
  }

  const name = named || `wt-${Date.now()}`;
  if (!nameOk(name)) throw new Error("name segments may contain only letters, digits, dots, underscores, and dashes (max 64 chars)");
  const dest = join(workspace, ".claude", "worktrees", name);
  mkdirSync(join(workspace, ".claude", "worktrees"), { recursive: true });
  const ran = await git(workspace, ["worktree", "add", "--detach", dest]);
  if (ran.code !== 0) {
    throw new Error((ran.stderr || ran.stdout || "git worktree add failed").trim());
  }
  persistCwd(workspace, sessionId, dest, roots);
  states.set(sessionId, { originalCwd: workspace, worktreePath: dest, created: true });
  return { worktreePath: dest, message: `Created and entered worktree ${dest}` };
}

export async function exitWorktreeTool(
  workspace: string,
  frame: ToolFrame,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sessionId = frame.sessionId || "";
  const action = asString(input.action);
  if (action !== "keep" && action !== "remove") throw new Error('action must be "keep" or "remove"');
  const state = states.get(sessionId);
  const current = sessionCwd(frame, workspace);
  const worktreePath = state?.worktreePath ?? current;
  if (action === "remove") {
    if (!state?.created && !asBool(input.discard_changes)) {
      const status = await git(worktreePath, ["status", "--porcelain"]);
      if (status.stdout.trim()) {
        throw new Error("Worktree has uncommitted files. Pass discard_changes: true to remove it.");
      }
    }
    const removed = await git(workspace, ["worktree", "remove", ...(asBool(input.discard_changes) ? ["--force"] : []), worktreePath]);
    if (removed.code !== 0) throw new Error((removed.stderr || removed.stdout || "git worktree remove failed").trim());
  }
  resetSessionCwd(sessionId);
  states.delete(sessionId);
  return {
    action,
    originalCwd: state?.originalCwd ?? workspace,
    worktreePath,
    worktreeBranch: state?.worktreeBranch,
    message: action === "remove" ? `Removed worktree ${worktreePath}` : `Left worktree ${worktreePath}`,
  };
}
