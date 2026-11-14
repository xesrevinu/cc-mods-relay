import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { hostDirFor, hostTuiRoot, opaqueId, relFromLocalHome, resetConfigForTests } from "../src/config.js";

const home = homedir();

beforeEach(() => {
  process.env.CC_MODS_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cc-mods-cfg-"));
  resetConfigForTests({ dir: "Workspace", ws: "home" }, {});
});

afterEach(() => {
  resetConfigForTests(undefined, undefined);
  delete process.env.CC_MODS_CONFIG_DIR;
});

test("home layout mirrors the path under the client home", () => {
  expect(hostDirFor(home, "studio")).toBe(".");
  expect(hostDirFor(join(home, "Workspace", "aws"), "studio")).toBe("Workspace/aws");
  expect(hostDirFor(join(home, ".cursor", "worktrees", "wt", "x"), "studio")).toBe(
    ".cursor/worktrees/wt/x",
  );
  expect(hostDirFor(join(home, "Workspace", "aws"), "studio")).not.toContain("studio");
  expect(hostDirFor(home, "studio")).not.toContain("Users");
});

test("path layout embeds hostname and cwd", () => {
  resetConfigForTests({ dir: "Workspace", ws: "path" }, {});
  expect(hostDirFor("/work/app", "box")).toBe("Workspace/ws/box/work/app");
});

test("opaque layout uses a stable hash without hostname or cwd text", () => {
  resetConfigForTests({ dir: "Workspace", ws: "opaque" }, {});
  const cwd = join(home, "Workspace", "aws");
  const a = hostDirFor(cwd, "studio");
  expect(a).toBe(`Workspace/ws/${opaqueId(cwd, "studio")}`);
  expect(a).not.toContain("studio");
});

test("relFromLocalHome strips the local home prefix", () => {
  expect(relFromLocalHome(join(home, "Workspace", "aws"))).toBe("Workspace/aws");
  expect(relFromLocalHome(home)).toBe(".");
});

test("relFromLocalHome uses an explicit client home, not this machine's home", () => {
  expect(relFromLocalHome("/Users/alice/Workspace/app", "/Users/alice")).toBe("Workspace/app");
  expect(relFromLocalHome("/Users/alice", "/Users/alice")).toBe(".");
});

test("hostDirFor maps a foreign user home onto the same relative path", () => {
  expect(hostDirFor("/Users/alice/Workspace/app", "mini", "/Users/alice")).toBe("Workspace/app");
  expect(hostDirFor("/Users/alice/.cursor/worktrees/wt/x", "mini", "/Users/alice")).toBe(
    ".cursor/worktrees/wt/x",
  );
  expect(hostDirFor("/Users/alice/Workspace/app", "mini", "/Users/alice")).not.toContain("Users/alice");
});

test("hostTuiRoot creates a missing client cwd so the TUI Environment matches the client", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "cc-mods-tui-mkdir-")), "project");
  expect(existsSync(dir)).toBe(false);
  expect(hostTuiRoot(dir, { home: "/Users/bob", clientHome: "/Users/alice" })).toBe(dir);
  expect(existsSync(dir)).toBe(true);
  expect(existsSync(join(dir, ".git"))).toBe(true);
});

test("hostTuiRoot git-inits an existing stub that is not a repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-tui-git-"));
  expect(existsSync(join(dir, ".git"))).toBe(false);
  expect(hostTuiRoot(dir, { home: "/Users/bob", clientHome: "/Users/alice" })).toBe(dir);
  expect(existsSync(join(dir, ".git"))).toBe(true);
});

test("hostTuiRoot does not re-init when .git already exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-tui-gitkeep-"));
  writeFileSync(join(dir, ".git"), "gitdir: /tmp/fake-worktree\n");
  expect(hostTuiRoot(dir, { home: "/Users/bob", clientHome: "/Users/alice" })).toBe(dir);
  expect(readFileSync(join(dir, ".git"), "utf8")).toBe("gitdir: /tmp/fake-worktree\n");
});

test("hostTuiRoot falls back under this home when the client cwd cannot be created", () => {
  expect(
    hostTuiRoot("/Users/someoneelse/Workspace/does-not-exist", {
      home: "/Users/bob",
      clientHome: "/Users/someoneelse",
    }),
  ).toBe("/Users/bob/Workspace/does-not-exist");
  expect(
    hostTuiRoot("/Users/someoneelse/.cursor/worktrees/wt/app", {
      home: "/Users/bob",
      clientHome: "/Users/someoneelse",
    }),
  ).toBe("/Users/bob/.cursor/worktrees/wt/app");
  expect(hostTuiRoot("/Users/someoneelse", { home: "/Users/bob", clientHome: "/Users/someoneelse" })).toBe("/Users/bob");
});

test("hostTuiRoot keeps cwd when that path exists here", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-tui-root-"));
  expect(hostTuiRoot(dir, { home: "/Users/bob", clientHome: "/Users/alice" })).toBe(dir);
});
