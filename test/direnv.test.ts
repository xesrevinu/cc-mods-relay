import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDirenvDump, withDirenv } from "../src/tools/direnv.js";
import { execute } from "../src/exec.js";

function run(dir: string, command: string, sessionId = "direnv-sess") {
  return new Promise<any>((resolve) => {
    void execute(
      { tool: "Bash", input: { command }, cwd: dir, tuiRoot: dir, callId: `t-${sessionId}`, sessionId },
      (frame) => resolve(frame),
    );
  });
}

test("applyDirenvDump sets strings and unsets nulls", () => {
  const env = applyDirenvDump(
    { PATH: "/bin", KEEP: "1", DROP: "x", STALE: "old" },
    { DROP: null, STALE: "new", ADDED: "y", IGNORE: 1 },
  );
  expect(env.PATH).toBe("/bin");
  expect(env.KEEP).toBe("1");
  expect(env.DROP).toBeUndefined();
  expect(env.STALE).toBe("new");
  expect(env.ADDED).toBe("y");
  expect(env.IGNORE).toBeUndefined();
});

test("applyDirenvDump ignores malformed dumps", () => {
  expect(applyDirenvDump({ A: "1" }, null).A).toBe("1");
  expect(applyDirenvDump({ A: "1" }, ["x"]).A).toBe("1");
});

test("withDirenv no-ops in a directory without .envrc", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-nodirenv-"));
  const env = await withDirenv(dir, { PATH: process.env.PATH, FOO: "keep" });
  expect(env.FOO).toBe("keep");
  expect(env.DIRENV_DIR).toBeUndefined();
});

test("Bash starts in the requested cwd", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-bash-cwd-"));
  const frame = await run(dir, "pwd -P", "cwd-only");
  expect(frame.ok).toBe(true);
  expect(frame.result.stdout.trim()).toBe(realpathSync(dir));
});

const direnv = Bun.which("direnv");

test("Bash loads an allowed .envrc from the tool cwd", async () => {
  if (!direnv) return;
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-direnv-"));
  writeFileSync(join(dir, ".envrc"), "export CC_MODS_DIRENV_TEST=from-envrc\n");
  const allowed = Bun.spawnSync([direnv, "allow", dir], { cwd: dir, stderr: "pipe" });
  expect(allowed.exitCode).toBe(0);
  try {
    const frame = await run(
      dir,
      "printf '%s\\n' \"$CC_MODS_DIRENV_TEST\" \"$(pwd -P)\"",
      "direnv-bash",
    );
    expect(frame.ok).toBe(true);
    expect(frame.result.stdout).toContain("from-envrc");
    expect(frame.result.stdout).toContain(realpathSync(dir));
  } finally {
    Bun.spawnSync([direnv, "deny", dir], { cwd: dir, stderr: "pipe" });
  }
});

test("Bash still runs when .envrc is blocked", async () => {
  if (!direnv) return;
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-direnv-block-"));
  writeFileSync(join(dir, ".envrc"), "export CC_MODS_DIRENV_TEST=should-not-load\n");
  Bun.spawnSync([direnv, "deny", dir], { cwd: dir, stderr: "pipe" });
  const frame = await run(dir, "echo ${CC_MODS_DIRENV_TEST:-missing}; pwd -P", "direnv-blocked");
  expect(frame.ok).toBe(true);
  expect(frame.result.stdout).toContain("missing");
  expect(frame.result.stdout).toContain(realpathSync(dir));
});
