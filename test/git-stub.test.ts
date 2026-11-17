import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostTuiRoot } from "../src/config.js";
import { applyGitStub, isGitBranchName, parseClientGit, readClientGit } from "../src/git-stub.js";

function git(dir: string, args: string[]): { code: number; stdout: string } {
  const ran = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = Buffer.isBuffer(ran.stdout) ? ran.stdout.toString() : String(ran.stdout ?? "");
  return { code: ran.exitCode ?? 1, stdout: stdout.trim() };
}

test("parseClientGit keeps a safe branch and drops the rest", () => {
  expect(parseClientGit({ repo: true, branch: "herdr/moonbit-migration" })).toEqual({
    repo: true,
    branch: "herdr/moonbit-migration",
  });
  expect(parseClientGit({ repo: false })).toEqual({ repo: false });
  expect(parseClientGit({ repo: true, branch: "-evil" })).toEqual({ repo: true });
  expect(parseClientGit({ repo: true, branch: "a..b" })).toEqual({ repo: true });
  expect(parseClientGit({ repo: "yes" })).toBeUndefined();
  expect(isGitBranchName("HEAD")).toBe(false);
});

test("readClientGit reports a named branch and a non-repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-git-read-"));
  expect(readClientGit(dir)).toEqual({ repo: false });
  git(dir, ["init", "-q", "-b", "feature-x"]);
  expect(readClientGit(dir)).toEqual({ repo: true, branch: "feature-x" });
});

test("readClientGit recovers a detached worktree branch instead of omitting it", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-git-detach-"));
  git(dir, ["init", "-q", "-b", "herdr/moonbit-migration"]);
  git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"]);
  const wt = join(dir, "wt");
  git(dir, ["worktree", "add", "--detach", wt]);
  expect(readClientGit(wt)).toEqual({ repo: true, branch: "herdr/moonbit-migration" });
});

test("applyGitStub does not invent main when the client branch is unknown", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-git-nobranch-"));
  applyGitStub(dir, { repo: true });
  expect(existsSync(join(dir, ".git"))).toBe(false);
});

test("applyGitStub names an empty stub after the client branch", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-git-stub-"));
  applyGitStub(dir, { repo: true, branch: "herdr/moonbit-migration" });
  expect(git(dir, ["symbolic-ref", "--short", "HEAD"]).stdout).toBe("herdr/moonbit-migration");
});

test("applyGitStub retargets a leftover unborn main stub", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-git-retarget-"));
  git(dir, ["init", "-q", "-b", "main"]);
  applyGitStub(dir, { repo: true, branch: "feature-x" });
  expect(git(dir, ["symbolic-ref", "--short", "HEAD"]).stdout).toBe("feature-x");
});

test("applyGitStub does not move a stub that already has commits", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-git-keep-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"]);
  applyGitStub(dir, { repo: true, branch: "feature-x" });
  expect(git(dir, ["symbolic-ref", "--short", "HEAD"]).stdout).toBe("main");
});

test("applyGitStub skips git init when the client cwd is not a repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-git-skip-"));
  applyGitStub(dir, { repo: false });
  expect(existsSync(join(dir, ".git"))).toBe(false);
});

test("hostTuiRoot uses the client git facts on a new stub", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "cc-mods-tui-gitfacts-")), "project");
  expect(hostTuiRoot(dir, { git: { repo: true, branch: "feature-x" } })).toBe(dir);
  expect(git(dir, ["symbolic-ref", "--short", "HEAD"]).stdout).toBe("feature-x");
  const plain = join(mkdtempSync(join(tmpdir(), "cc-mods-tui-nongit-")), "project");
  expect(hostTuiRoot(plain, { git: { repo: false } })).toBe(plain);
  expect(existsSync(join(plain, ".git"))).toBe(false);
});
