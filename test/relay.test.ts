import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withPlugin } from "../src/compose.js";
import { mapPath } from "../src/exec.js";
import { createBunPtySpawn } from "../src/bun-pty-backend.js";
import { startModChannel } from "../src/mod-channel.js";
import { startRelay } from "../src/relay.js";
import { stagePlugin } from "../src/launch.js";
import { acpTunnelArgs } from "../src/ssh.js";
import { resolveTerminalBackendName } from "../src/terminal-backend.js";
import { HOST_WRONG_TOOLS, WORKSPACE_TOOLS } from "../src/tools/forward.js";

test("withPlugin injects --plugin-dir on the claude command, not path fragments", () => {
  const tui = "claude --session-id sess --mcp-config /tmp/claude-abc/x.json";
  const local = withPlugin(tui, "/opt/plugin");
  expect(local).toBe("claude --plugin-dir '/opt/plugin' --session-id sess --mcp-config /tmp/claude-abc/x.json");
  expect(withPlugin("claude --resume \"s\" || claude", "/opt/plugin")).toBe(
    "claude --plugin-dir '/opt/plugin' --resume \"s\" || claude --plugin-dir '/opt/plugin'",
  );
  expect(() => withPlugin("claude", "relative")).toThrow();
  expect(() => withPlugin("echo hi", "/opt/plugin")).toThrow();
});

test("ACP ssh carries stdio and the tool port, not a TTY wrapping claude", () => {
  const argv = acpTunnelArgs("mini", 4321, "bun /home/me/.cc-mods-relay/agent.js --plugin-dir /home/me/.cc-mods-relay/plugin");
  expect(argv).toContain("-T");
  expect(argv).not.toContain("-tt");
  expect(argv.join(" ")).toContain("127.0.0.1:4321:127.0.0.1:4321");
  expect(argv.join(" ")).toContain("agent.js");
  expect(argv.join(" ")).not.toMatch(/\bclaude -p\b/);
});

test("localhost ssh skips -R because the relay is already bound here", () => {
  const argv = acpTunnelArgs("localhost", 4321, "bun agent.js --plugin-dir /tmp/plugin");
  expect(argv.join(" ")).not.toContain("-R");
  expect(argv.join(" ")).not.toContain("ExitOnForwardFailure");
});

test("Mods plugin source stays inside the sandbox", () => {
  const src = readFileSync(join(import.meta.dir, "../plugin/hooks/register.js"), "utf8");
  expect(src).not.toMatch(/\bWebSocket\b/);
  expect(src).not.toMatch(/\bsetTimeout\b/);
  expect(src).toContain("$.process.run");
  expect(src).toContain("$.process.spawn");
  expect(src).toContain("WORKSPACE_TOOLS");
  expect(src).toContain("HOST_WRONG_TOOLS");
  expect(src).toContain("classic.Stop");
  expect(src).toContain("classic.PermissionRequest");
  expect(src).toContain("HYDRATE_TOOLS");
  expect(src).toContain("CC_MODS_SOCKET");
  expect(src).toContain("extra-dirs.json");
  expect(src).not.toContain("CC_MODS_EXTRA_DIRS");
  expect(src).toContain('on("turn.step"');
  expect(src).toContain("rpcRetry");
  expect(src).toContain('type: "cancel"');
  expect(src).toContain("plugin_error");
  expect(src).not.toContain("asUser");
  expect(src).not.toContain("/poll");
  for (const tool of WORKSPACE_TOOLS) expect(src).toContain(`"${tool}"`);
  for (const tool of HOST_WRONG_TOOLS) expect(src).toContain(`"${tool}"`);
});

test("terminal backend defaults to herdr and accepts bun PTY aliases", () => {
  expect(resolveTerminalBackendName({})).toBe("herdr");
  expect(resolveTerminalBackendName({ CLAUDE_TUI_BACKEND: "pty" })).toBe("bun-pty");
  expect(resolveTerminalBackendName({ CLAUDE_TUI_BACKEND: "node-pty" })).toBe("bun-pty");
});

test("bun PTY spawn presents a TTY", async () => {
  const spawn = createBunPtySpawn();
  const chunks: string[] = [];
  const handle = spawn(process.execPath, ["-e", "process.stdout.write('tty=' + process.stdout.isTTY)"], {
    cwd: process.cwd(),
    env: process.env as { [key: string]: string },
    cols: 40,
    rows: 12,
  });
  handle.onData((data) => chunks.push(data));
  const exit = new Promise<number>((resolve) => handle.onExit((event) => resolve(event.exitCode)));
  expect(await exit).toBe(0);
  expect(chunks.join("")).toContain("tty=true");
});

test("mod-channel delivers events, not prompts", async () => {
  const channel = startModChannel();
  const seen: unknown[] = [];
  const stop = channel.onEvent((event) => seen.push(event));
  try {
    const hello = await fetch("http://adapter/hello", { method: "POST", unix: channel.path, body: "{}" });
    expect(hello.ok).toBe(true);
    const posted = await fetch("http://adapter/events", {
      method: "POST",
      unix: channel.path,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [{ type: "chunk", kind: "text", text: "hi" }] }),
    });
    expect(posted.ok).toBe(true);
    expect(seen).toEqual([{ type: "chunk", kind: "text", text: "hi" }]);
    expect((await fetch("http://adapter/poll", { unix: channel.path })).status).toBe(404);
  } finally {
    stop();
    channel.stop();
  }
});

test("tuiRoot paths map onto this machine's cwd; escapes are rejected", () => {
  const cwd = "/Users/me/proj";
  const tui = "/Users/ray/Workspace/abc";
  expect(mapPath(cwd, tui, "/Users/ray/Workspace/abc/src/a.ts")).toBe("/Users/me/proj/src/a.ts");
  expect(mapPath(cwd, tui, "src/a.ts")).toBe("/Users/me/proj/src/a.ts");
  expect(() => mapPath(cwd, tui, "/etc/passwd")).toThrow(/outside/);
});

test("tool calls run here; unknown tools fail closed; calls need hello", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-"));
  writeFileSync(join(dir, "hello.txt"), "hello\n");
  const relay = startRelay();
  relay.bind("s1", dir);
  try {
    const ws = new WebSocket(relay.url);
    const next = () => new Promise<any>((resolve) => {
      const prev = ws.onmessage;
      ws.onmessage = (event) => {
        ws.onmessage = prev;
        resolve(JSON.parse(String(event.data)));
      };
    });
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("socket failed"));
    });

    const unauth = next();
    ws.send(JSON.stringify({ v: 1, type: "call", id: "x", tool: "Bash", input: { command: "echo pwn" } }));
    expect((await unauth).error.code).toBe("UNAUTHORIZED");

    const hello = next();
    ws.send(JSON.stringify({ v: 1, type: "hello", token: relay.token, cwd: dir }));
    expect((await hello).ok).toBe(true);

    const read = next();
    ws.send(JSON.stringify({ v: 1, type: "call", id: "1", callId: "c1", tool: "Read", input: { file_path: join(dir, "hello.txt") } }));
    const body = await read;
    expect(body.ok).toBe(true);
    expect(body.result.type).toBe("text");
    expect(body.result.file.content).toContain("hello");

    const agent = next();
    ws.send(JSON.stringify({ v: 1, type: "call", id: "2", callId: "c2", tool: "Agent", input: { prompt: "no" } }));
    const denied = await agent;
    expect(denied.ok).toBe(false);
    expect(denied.error.code).toBe("UNSUPPORTED_TOOL"); // plugin never forwards Agent; executor still fail-closes if asked

    const frames: any[] = [];
    const done = new Promise<any[]>((resolve) => {
      ws.onmessage = (event) => {
        frames.push(JSON.parse(String(event.data)));
        if (frames.some((frame) => frame.type === "notify")) resolve(frames);
      };
    });
    ws.send(JSON.stringify({
      v: 1, type: "call", id: "bg", callId: "bash-1", tool: "Bash",
      input: { command: "echo from-background", run_in_background: true },
    }));
    const both = await done;
    const result = both.find((frame) => frame.type === "result");
    const note = both.find((frame) => frame.type === "notify");
    expect(result.result.backgroundTaskId).toBeDefined();
    expect(both.indexOf(result)).toBeLessThan(both.indexOf(note));
    expect(note.output).toContain("from-background");
    ws.close();
  } finally {
    relay.stop();
  }
});

test("staged plugin is minified and does not ship sources or types", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-"));
  writeFileSync(join(dir, "hello.txt"), "hello\n");
  const staged = await stagePlugin({
    url: "ws://127.0.0.1:9/tools",
    token: "stage-token",
    cwd: dir,
    tuiRoot: dir,
  });
  const register = readFileSync(join(staged, "hooks/register.js"), "utf8");
  const helper = readFileSync(join(staged, "hooks/ws-client.js"), "utf8");
  expect(register).toContain("ws://127.0.0.1:9/tools");
  expect(register).toContain("stage-token");
  expect(register).toMatch(/export\{[A-Za-z$][\w$]* as register\}/);
  expect(register).not.toContain("Mods forbids");
  expect(register).not.toContain("ENDPOINT");
  expect(register).not.toMatch(/\bWebSocket\b/);
  expect(register).not.toMatch(/\bsetTimeout\b/);
  expect(register.length).toBeLessThan(readFileSync(join(import.meta.dir, "../plugin/hooks/register.js"), "utf8").length);
  expect(helper).not.toContain("Out-of-sandbox");
  expect(helper).toContain("WebSocket");
  expect(existsSync(join(staged, "tsconfig.json"))).toBe(false);
  expect(existsSync(join(staged, ".claude-plugin/types"))).toBe(false);
  expect(JSON.parse(readFileSync(join(staged, ".claude-plugin/plugin.json"), "utf8")).name).toBe(
    "studio-ws-executor",
  );
  expect(existsSync(join(staged, "hooks/hooks.json"))).toBe(true);
  expect(existsSync(join(staged, "hooks/write-file.js"))).toBe(true);
});

test("the out-of-sandbox helper speaks the tool protocol", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-"));
  writeFileSync(join(dir, "hello.txt"), "hello\n");
  const relay = startRelay();
  relay.bind("s1", dir);
  try {
    const helper = join(import.meta.dir, "../plugin/hooks/ws-client.js");
    const proc = Bun.spawn(["bun", helper], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(JSON.stringify({
      url: relay.url,
      token: relay.token,
      cwd: dir,
      tuiRoot: dir,
      type: "call",
      id: "1",
      callId: "c1",
      tool: "Read",
      input: { file_path: join(dir, "hello.txt") },
    }));
    proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const frame = JSON.parse(stdout.trim());
    expect(frame.ok).toBe(true);
    expect(frame.result.file.content).toContain("hello");
  } finally {
    relay.stop();
  }
});

test("Read is not blocked by a concurrent long Bash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-"));
  writeFileSync(join(dir, "hello.txt"), "hello\n");
  const relay = startRelay();
  relay.bind("s1", dir);
  try {
    const ws = new WebSocket(relay.url);
    const frames: any[] = [];
    let readAt = 0;
    let started = 0;
    const next = () => new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("socket timed out")), 8_000);
      const prev = ws.onmessage;
      ws.onmessage = (event) => {
        ws.onmessage = prev;
        clearTimeout(timer);
        resolve(JSON.parse(String(event.data)));
      };
    });
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("socket failed"));
    });
    const hello = next();
    ws.send(JSON.stringify({ v: 1, type: "hello", token: relay.token, cwd: dir }));
    expect((await hello).ok).toBe(true);

    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("concurrent tools timed out")), 8_000);
      ws.onmessage = (event) => {
        const frame = JSON.parse(String(event.data));
        frames.push(frame);
        if (frame.callId === "read-fast" && frame.type === "result") readAt = Date.now();
        if (frames.filter((f) => f.type === "result").length >= 2) {
          clearTimeout(timer);
          resolve();
        }
      };
    });
    started = Date.now();
    ws.send(JSON.stringify({ v: 1, type: "call", id: "bash", callId: "bash-slow", tool: "Bash", input: { command: "sleep 0.8" } }));
    ws.send(JSON.stringify({
      v: 1, type: "call", id: "read", callId: "read-fast", tool: "Read",
      input: { file_path: join(dir, "hello.txt") },
    }));
    await done;
    const read = frames.find((f) => f.callId === "read-fast" && f.type === "result");
    const bash = frames.find((f) => f.callId === "bash-slow" && f.type === "result");
    expect(read?.ok).toBe(true);
    expect(read?.result.file.content).toContain("hello");
    expect(bash?.ok).toBe(true);
    expect(readAt).toBeGreaterThan(0);
    expect(readAt - started).toBeLessThan(500);
    ws.close();
  } finally {
    relay.stop();
  }
});

test("cancel stops an in-flight Bash over the tool socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-"));
  const relay = startRelay();
  relay.bind("s1", dir);
  try {
    const ws = new WebSocket(relay.url);
    const next = () => new Promise<any>((resolve) => {
      const prev = ws.onmessage;
      ws.onmessage = (event) => {
        ws.onmessage = prev;
        resolve(JSON.parse(String(event.data)));
      };
    });
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("socket failed"));
    });
    const hello = next();
    ws.send(JSON.stringify({ v: 1, type: "hello", token: relay.token, cwd: dir }));
    expect((await hello).ok).toBe(true);

    const started = Date.now();
    const result = next();
    ws.send(JSON.stringify({
      v: 1, type: "call", id: "bash", callId: "bash-cancel", tool: "Bash",
      input: { command: "sleep 30" },
    }));
    await Bun.sleep(80);
    ws.send(JSON.stringify({ v: 1, type: "cancel", callId: "bash-cancel" }));
    const body = await result;
    expect(body.ok).toBe(true);
    expect(body.result.interrupted).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    ws.close();
  } finally {
    relay.stop();
  }
});

test("helper prints a result when the executor socket is gone", async () => {
  const helper = join(import.meta.dir, "../plugin/hooks/ws-client.js");
  const proc = Bun.spawn(["bun", helper], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify({
    url: "ws://127.0.0.1:9/tools",
    token: "nope",
    cwd: "/tmp",
    tuiRoot: "/tmp",
    type: "call",
    id: "1",
    callId: "c1",
    tool: "Read",
    input: { file_path: "/tmp/x" },
  }));
  proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  expect(await proc.exited).not.toBe(0);
  const frame = JSON.parse(stdout.trim().split("\n").at(-1)!);
  expect(frame.ok).toBe(false);
  expect(frame.error.code).toBe("EXECUTOR_DISCONNECTED");
});
