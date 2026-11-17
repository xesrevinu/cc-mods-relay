import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyBashIntent, stripRedundantCd } from "../src/tools/bash-intent.js";
import { execute } from "../src/exec.js";

test("stripRedundantCd drops cd onto the session cwd and keeps a real directory change", () => {
  const cwd = "/Users/me/proj";
  expect(stripRedundantCd("cd /Users/me/proj && ls", cwd)).toBe("ls");
  expect(stripRedundantCd("cd '/Users/me/proj' && cat a.ts", cwd)).toBe("cat a.ts");
  expect(stripRedundantCd("cd /Users/me/other && ls", cwd)).toBe("cd /Users/me/other && ls");
});

test("classifyBashIntent prefers Read/Grep/Glob for single-purpose commands", () => {
  const cwd = "/Users/me/proj";
  expect(classifyBashIntent("cat macos/moon.pkg", cwd)).toEqual({
    action: "prefer",
    tool: "Read",
    message: "Use the Read tool with file_path: macos/moon.pkg instead of cat.",
  });
  expect(classifyBashIntent("head -n 80 macos/host_shell.mbt", cwd)).toMatchObject({ action: "prefer", tool: "Read" });
  expect(classifyBashIntent("sed -n 1,140p macos/host_shell.mbt", cwd)).toMatchObject({ action: "prefer", tool: "Read" });
  expect(classifyBashIntent(`rg -n "UiBindSlot" hermes --glob '*.mbt'`, cwd)).toMatchObject({
    action: "prefer",
    tool: "Grep",
  });
  expect(classifyBashIntent("find macos -type f -name '*.mbt'", cwd)).toMatchObject({ action: "prefer", tool: "Glob" });
});

test("classifyBashIntent splits sequential cat && rg toward Read then Grep", () => {
  const cwd = "/Users/me/proj";
  const seq = classifyBashIntent("cat a.ts && rg foo a.ts && ls", cwd);
  expect(seq.action).toBe("prefer");
  if (seq.action === "prefer") {
    expect(seq.message).toMatch(/Read tool with file_path: a.ts/);
    expect(seq.message).toMatch(/Grep tool with pattern: foo/);
    expect(seq.message).toMatch(/Do not use Bash/);
  }
});

test("classifyBashIntent keeps pipes, git, and mixed native+shell as Bash", () => {
  const cwd = "/Users/me/proj";
  expect(classifyBashIntent("git branch --show-current && git status --short", cwd).action).toBe("run");
  expect(classifyBashIntent("rg -n foo macos | grep -v test", cwd).action).toBe("run");
  expect(classifyBashIntent("cat a.ts && moon check", cwd).action).toBe("run");
});

test("classifyBashIntent strips a redundant cd then prefers Read", () => {
  const cwd = "/Users/me/proj";
  expect(classifyBashIntent("cd /Users/me/proj && cat macos/moon.pkg", cwd)).toMatchObject({
    action: "prefer",
    tool: "Read",
  });
  expect(classifyBashIntent("cd /Users/me/proj && git status", cwd)).toEqual({
    action: "run",
    command: "git status",
  });
  expect(classifyBashIntent("FOO=1 cat macos/moon.pkg", cwd).action).toBe("prefer");
});

test("classifyBashIntent keeps redirects, heredocs, find -delete, and real cd as Bash", () => {
  const cwd = "/Users/me/proj";
  expect(classifyBashIntent("cat a.ts > b.ts", cwd).action).toBe("run");
  expect(classifyBashIntent("cat a.ts >> b.ts", cwd).action).toBe("run");
  expect(classifyBashIntent("cat <<'EOF'\nhi\nEOF", cwd).action).toBe("run");
  expect(classifyBashIntent("find macos -name '*.mbt' -delete", cwd).action).toBe("run");
  expect(classifyBashIntent("git cat-file -p HEAD", cwd).action).toBe("run");
  expect(classifyBashIntent("cd /Users/me/other && cat a.ts", cwd).action).toBe("run");
  expect(classifyBashIntent("echo hi > out.txt && cat a.ts", cwd).action).toBe("run");
  expect(classifyBashIntent("rg foo 2>/dev/null", cwd).action).toBe("run");
});

test("Bash cat of one file is denied toward Read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-bash-intent-"));
  const frame = await new Promise<any>((resolve) => {
    void execute(
      { tool: "Bash", input: { command: "cat a.ts" }, cwd: dir, tuiRoot: dir, callId: "cat1" },
      (next) => resolve(next),
    );
  });
  expect(frame.ok).toBe(false);
  expect(frame.error.message).toMatch(/Use the Read tool/);
});

test("Bash still runs printf, redirects, and git after the classifier", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-bash-ok-"));
  const printf = await new Promise<any>((resolve) => {
    void execute({ tool: "Bash", input: { command: "printf hi" }, cwd: dir, tuiRoot: dir, callId: "p" }, (next) => resolve(next));
  });
  expect(printf.ok).toBe(true);
  expect(printf.result.stdout).toContain("hi");

  const redirect = await new Promise<any>((resolve) => {
    void execute(
      { tool: "Bash", input: { command: "cat > wrote.txt <<'EOF'\nbody\nEOF" }, cwd: dir, tuiRoot: dir, callId: "r" },
      (next) => resolve(next),
    );
  });
  expect(redirect.ok).toBe(true);
  expect(await Bun.file(join(dir, "wrote.txt")).text()).toBe("body\n");

  const seq = await new Promise<any>((resolve) => {
    void execute(
      { tool: "Bash", input: { command: "cat a.ts && rg foo a.ts && ls" }, cwd: dir, tuiRoot: dir, callId: "s" },
      (next) => resolve(next),
    );
  });
  expect(seq.ok).toBe(false);
  expect(seq.error.message).toMatch(/Read tool/);
  expect(seq.error.message).toMatch(/Grep tool/);
});
