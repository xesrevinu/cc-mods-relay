import { expect, test } from "bun:test";
import { createBunPtySpawn } from "../src/bun-pty-backend.js";
import { createHerdrSpawn } from "../src/herdr-backend.js";
import { buildClaudeCmd } from "../src/engine-pty.js";
import { pidAlive } from "../src/tui-lifetime.js";

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
  expect(pidAlive(pid)).toBe(true);
  const exit = new Promise<number>((resolve) => handle.onExit((event) => resolve(event.exitCode)));
  handle.kill();
  await Promise.race([exit, Bun.sleep(2_000).then(() => -1)]);
  await Bun.sleep(50);
  expect(pidAlive(pid)).toBe(false);
});

function herdrOk(result: unknown) {
  return { status: 0, stdout: JSON.stringify({ result }), stderr: "" };
}

function mockHerdr(opts: {
  processInfo: () => unknown;
  onClose?: (id: string) => void;
}) {
  const calls: string[] = [];
  const runCli = (argv: string[]) => {
    const i = argv.indexOf("--session");
    const cmd = argv.slice(i >= 0 ? i + 2 : 1);
    calls.push(cmd.join(" "));
    if (cmd[0] === "workspace" && cmd[1] === "create") {
      return herdrOk({
        workspace: { workspace_id: "ws1" },
        tab: { tab_id: "tab1" },
        root_pane: { pane_id: "pane1" },
      });
    }
    if (cmd[0] === "workspace" && cmd[1] === "close") {
      opts.onClose?.(cmd[2] || "");
      return herdrOk({ type: "ok" });
    }
    if (cmd[0] === "pane" && cmd[1] === "read") {
      return { status: 0, stdout: "for shortcuts", stderr: "" };
    }
    if (cmd[0] === "pane" && cmd[1] === "process-info") {
      return herdrOk(opts.processInfo());
    }
    return { status: 0, stdout: "{}", stderr: "" };
  };
  return { calls, spawn: createHerdrSpawn({ runCli, pollMs: 40, readyTimeoutMs: 1_000 }) };
}

function processInfo(procs: { name: string; pid: number; cmdline: string }[]) {
  return { process_info: { foreground_processes: procs } };
}

test("herdr kill closes the workspace it created", () => {
  const { calls, spawn } = mockHerdr({
    processInfo: () => processInfo([{ name: "claude", pid: 4242, cmdline: "claude" }]),
  });
  const handle = spawn("/bin/sh", ["-c", "claude"], { cwd: process.cwd(), env: {} });
  handle.kill();
  expect(calls.some((c) => c.startsWith("workspace close ws1"))).toBe(true);
});

test("herdr does not close the workspace when bun is foreground but the TUI pid lives", async () => {
  const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  const pid = child.pid;
  expect(pid).toBeGreaterThan(1);
  let closed = false;
  let infoCount = 0;
  const { spawn } = mockHerdr({
    onClose: () => {
      closed = true;
    },
    processInfo: () => {
      infoCount += 1;
      return infoCount < 2
        ? processInfo([{ name: "claude", pid, cmdline: "claude --plugin-dir" }])
        : processInfo([{ name: "bun", pid, cmdline: "bun ws-client.js" }]);
    },
  });
  try {
    const handle = spawn("/bin/sh", ["-c", "claude"], { cwd: process.cwd(), env: {} });
    const start = Date.now();
    while (infoCount < 4 && Date.now() - start < 1_000) await Bun.sleep(20);
    expect(infoCount).toBeGreaterThanOrEqual(2);
    expect(closed).toBe(false);
    handle.kill();
    expect(closed).toBe(true);
  } finally {
    try {
      child.kill();
    } catch {
    }
    await child.exited;
  }
});

test("herdr closes the workspace after every seen TUI pid is dead", async () => {
  let closed = false;
  let infoCount = 0;
  const { spawn } = mockHerdr({
    onClose: () => {
      closed = true;
    },
    processInfo: () => {
      infoCount += 1;
      return infoCount < 2
        ? processInfo([{ name: "claude", pid: 99_999_991, cmdline: "claude" }])
        : processInfo([]);
    },
  });
  spawn("/bin/sh", ["-c", "claude"], { cwd: process.cwd(), env: {} });
  const start = Date.now();
  while (!closed && Date.now() - start < 1_000) await Bun.sleep(20);
  expect(closed).toBe(true);
});
