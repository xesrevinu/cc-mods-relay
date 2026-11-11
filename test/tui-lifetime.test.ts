import { expect, test } from "bun:test";
import { createBunPtySpawn } from "../src/bun-pty-backend.js";
import { createHerdrSpawn } from "../src/herdr-backend.js";
import { buildClaudeCmd } from "../src/engine-pty.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("fresh TUI command execs claude over the shell", () => {
  expect(buildClaudeCmd("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").startsWith("exec claude --session-id ")).toBe(true);
});

test("bun PTY kill reaps the child process", async () => {
  const spawn = createBunPtySpawn();
  const handle = spawn("/bin/sh", ["-c", "sleep 30"], {
    cwd: process.cwd(),
    env: process.env as { [key: string]: string },
  });
  const pid = handle.pid;
  expect(pid).toBeGreaterThan(1);
  expect(alive(pid)).toBe(true);
  const exit = new Promise<number>((resolve) => handle.onExit((event) => resolve(event.exitCode)));
  handle.kill();
  await Promise.race([exit, Bun.sleep(2_000).then(() => -1)]);
  await Bun.sleep(50);
  expect(alive(pid)).toBe(false);
});

test("herdr kill closes the workspace it created", () => {
  const calls: string[] = [];
  const runCli = (argv: string[]) => {
    const i = argv.indexOf("--session");
    const cmd = argv.slice(i >= 0 ? i + 2 : 1);
    calls.push(cmd.join(" "));
    if (cmd[0] === "workspace" && cmd[1] === "create") {
      return {
        status: 0,
        stdout: JSON.stringify({
          result: {
            workspace: { workspace_id: "ws1" },
            tab: { tab_id: "tab1" },
            root_pane: { pane_id: "pane1" },
          },
        }),
        stderr: "",
      };
    }
    if (cmd[0] === "pane" && cmd[1] === "read") {
      return { status: 0, stdout: "for shortcuts", stderr: "" };
    }
    if (cmd[0] === "pane" && cmd[1] === "process-info") {
      return {
        status: 0,
        stdout: JSON.stringify({
          result: {
            process_info: { foreground_processes: [{ name: "claude", pid: 4242, cmdline: "claude" }] },
          },
        }),
        stderr: "",
      };
    }
    return { status: 0, stdout: "{}", stderr: "" };
  };
  const spawn = createHerdrSpawn({ runCli, pollMs: 10_000, readyTimeoutMs: 1_000 });
  const handle = spawn("/bin/sh", ["-c", "claude"], { cwd: process.cwd(), env: {} });
  handle.kill();
  expect(calls.some((c) => c.startsWith("workspace close ws1"))).toBe(true);
});
