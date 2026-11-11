import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { hostDirFor, opaqueId, relFromLocalHome, resetConfigForTests } from "../src/config.js";

const home = homedir();

beforeEach(() => {
  process.env.CC_MODS_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cc-mods-cfg-"));
  resetConfigForTests({ dir: "Workspace", ws: "home" }, {});
});

afterEach(() => {
  resetConfigForTests(undefined, undefined);
  delete process.env.CC_MODS_CONFIG_DIR;
});

test("home layout uses Workspace/<path under local home>", () => {
  expect(hostDirFor(home, "studio")).toBe("Workspace");
  expect(hostDirFor(join(home, "Workspace", "aws"), "studio")).toBe("Workspace/aws");
  expect(hostDirFor(join(home, ".cursor", "worktrees", "holt", "x"), "studio")).toBe(
    "Workspace/.cursor/worktrees/holt/x",
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
