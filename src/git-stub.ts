import { existsSync } from "node:fs";
import { join } from "node:path";

/** Client cwd git facts. The TUI stub copies the boolean and branch, not objects. */
export type ClientGit = {
  repo: boolean;
  branch?: string;
};

export function isGitBranchName(name: string): boolean {
  if (!name || name.length > 255 || name === "HEAD") return false;
  if (name.startsWith("/") || name.startsWith("-") || name.endsWith("/") || name.endsWith(".lock")) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{") || name.includes("\\")) return false;
  return /^[A-Za-z0-9._][A-Za-z0-9._\-/]*$/.test(name);
}

export function parseClientGit(raw: unknown): ClientGit | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as { repo?: unknown; branch?: unknown };
  if (typeof row.repo !== "boolean") return undefined;
  if (typeof row.branch === "string" && isGitBranchName(row.branch)) return { repo: row.repo, branch: row.branch };
  return { repo: row.repo };
}

function git(dir: string, args: string[]): { code: number; stdout: string } {
  const ran = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = Buffer.isBuffer(ran.stdout) ? ran.stdout.toString() : String(ran.stdout ?? "");
  return { code: ran.exitCode ?? 1, stdout: stdout.trim() };
}

function isHomePrefix(path: string): boolean {
  return /^\/Users\/[^/]+$/.test(path) || /^\/home\/[^/]+$/.test(path);
}

function canTouchGit(dir: string): boolean {
  return dir.startsWith("/") && !/[\n\r]/.test(dir) && dir !== "/" && dir !== "/Users" && dir !== "/home" && !isHomePrefix(dir);
}

function hasCommits(dir: string): boolean {
  return git(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]).code === 0;
}

export function readClientGit(cwd: string): ClientGit {
  if (!cwd.startsWith("/") || /[\n\r]/.test(cwd) || !existsSync(cwd)) return { repo: false };
  const inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout !== "true") return { repo: false };
  const named = git(cwd, ["symbolic-ref", "--short", "HEAD"]);
  if (named.code === 0 && isGitBranchName(named.stdout)) return { repo: true, branch: named.stdout };
  return { repo: true };
}

function ensureGitRepo(dir: string, branch?: string): void {
  if (!canTouchGit(dir)) return;
  if (existsSync(join(dir, ".git"))) return;
  const args =
    branch && isGitBranchName(branch) ? ["init", "-q", "-b", branch, dir] : ["init", "-q", dir];
  try {
    Bun.spawnSync(["git", ...args], { stdout: "ignore", stderr: "ignore" });
  } catch {
    /* git missing */
  }
}

/**
 * Claude Code's Environment `Is a git repository` / `gitBranch` come from this
 * cwd. Mirror the client's facts on an empty stub; leave a real history alone.
 * `undefined` keeps the old `git init` (unborn default branch) for old clients.
 */
export function applyGitStub(dir: string, state?: ClientGit): void {
  if (!canTouchGit(dir) || !existsSync(dir)) return;
  if (!state) {
    ensureGitRepo(dir);
    return;
  }
  if (!state.repo) return;
  ensureGitRepo(dir, state.branch);
  if (!state.branch || !existsSync(join(dir, ".git")) || hasCommits(dir)) return;
  git(dir, ["symbolic-ref", "HEAD", `refs/heads/${state.branch}`]);
}
