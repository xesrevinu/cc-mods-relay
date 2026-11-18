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
import { resolveTerminalBackendName } from "../src/terminal-backend.js";
import { DEFERRED_TOOLS, isLocalTool, WORKSPACE_TOOLS } from "../src/tools/forward.js";

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

test("Mods plugin source stays inside the sandbox", () => {
  const src = readFileSync(join(import.meta.dir, "../plugin/hooks/register.js"), "utf8");
  expect(src).not.toMatch(/\bWebSocket\b/);
  expect(src).not.toMatch(/\bsetTimeout\b/);
  expect(src).toContain("$.process.run");
  expect(src).toContain("$.process.spawn");
  expect(src).toContain("WORKSPACE_TOOLS");
  expect(src).toContain("DEFERRED_TOOLS");
  expect(src).toContain("failResult");
  expect(src).toContain("deny:");
  expect(src).toContain("objectResult");
  expect(src).toMatch(/^function errorResult\(/m);
  expect(src).toMatch(/^function permissionDenied\(/m);
  expect(src).not.toContain("return objectResult(tool, text, input)");
  expect(src).toContain("finish(true, result, message)");
  expect(src).toContain('return failResult("Tool call was cancelled")');
  expect(src).toContain("CALL_ID_CONFLICT");
  expect(src).toContain("PATH_DENIED");
  expect(src).toContain("error: text");
  expect(src).toContain("filenames: [], content: text");
  expect(src).toContain("File does not exist:");
  expect(src).toContain("return ran");
  expect(src).not.toContain('if (tool === "Grep" || tool === "Glob")');
  expect(src).toContain('if (tool === "Grep") return { numFiles: 0, filenames: [] }');
  expect(src).toContain('if (tool === "Glob") return { durationMs: 0, numFiles: 0, filenames: [], truncated: false }');
  expect(src).not.toContain("{ value: text }");
  expect(src).not.toContain("{ isError: true, result:");
  expect(src).not.toContain("if (e.agentId && !parent) return next(e)");
  expect(src).toContain("$.session.send");
  expect(src).toContain("$.session.id()");
  expect(src).not.toContain("$.session &&");
  expect(src).not.toContain("id.call($.session)");
  expect(src.match(/\$\.session(?!\.(?:id|send)\()/g) || []).toEqual([]);
  expect(src).toContain("claudeSessionId");
  expect(src).toContain("deliverTaskText");
  expect(src).toContain("isDelivered");
  expect(src).toContain("agentGone");
  expect(src).toContain("enqueue($, text, frame.agentId)");
  expect(src).toContain("flushPending($, e.agentId)");
  expect(src).toMatch(/^function enqueue\(/m);
  expect(src).toMatch(/^function kickFlush\(/m);
  expect(src).toMatch(/^async function flushPending\(/m);
  expect(src).toContain("pending.length >= 100");
  expect(src).toContain("<task-notification>");
  expect(src).toContain("kickFlush");
  expect(src).toContain("after($, 1_500)");
  expect(src).toContain("await sessionIdOf");
  expect(src).toContain("type: \"cancel\", agentId:");
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
  expect(src).not.toContain("This tool would run on the TUI host");
  expect(src).not.toContain("result: message");
  for (const tool of WORKSPACE_TOOLS) expect(src).toContain(`"${tool}"`);
  for (const tool of DEFERRED_TOOLS) expect(src).toContain(`"${tool}"`);
  expect(isLocalTool("REPL")).toBe(false);
  expect(src).toContain('e.tool !== "REPL"');
  expect(src).toContain("replStack");
  expect(src).toContain("sawReplThisTurn");
  expect(src).toContain("mainInflight");
  expect(src).toContain("resetPendingComplete");
  expect(src).toContain("if (e.isAborted) flushTurnComplete($, socket)");
  expect(src).toContain("sawReplThisTurn ? 8_000 : 400");
  expect(src).toMatch(/^function flushTurnComplete\(/m);
  expect(src).toMatch(/^function settleTurnComplete\(/m);
  expect(src).toMatch(/^function resetPendingComplete\(/m);
  const registerBody = src.slice(src.indexOf("export function register"));
  expect(registerBody).not.toMatch(/function \w+\(\$/);
  expect(registerBody).not.toMatch(/\(\$\s*\)\s*=>/);
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
  const tui = "/Users/bob/Workspace/abc";
  expect(mapPath(cwd, tui, "/Users/bob/Workspace/abc/src/a.ts")).toBe("/Users/me/proj/src/a.ts");
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
      agentId: "agent-sub-relay",
      input: { command: "echo from-background", run_in_background: true },
    }));
    const both = await done;
    const result = both.find((frame) => frame.type === "result");
    const note = both.find((frame) => frame.type === "notify");
    expect(result.result.backgroundTaskId).toBeDefined();
    expect(both.indexOf(result)).toBeLessThan(both.indexOf(note));
    expect(note.output).toContain("from-background");
    expect(note.agentId).toBe("agent-sub-relay");
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
  expect(register).toContain(".session.id()");
  expect(register).not.toMatch(/\.session&&/);
  expect(register).not.toMatch(/\.call\([^)]*session\)/);
  const pendingCap = register.indexOf(">=100");
  const registerFn = register.search(/function \w+\(\w\)\{let \w+=!1/);
  expect(pendingCap).toBeGreaterThan(0);
  expect(registerFn).toBeGreaterThan(pendingCap);
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
    await proc.stdin.write(JSON.stringify({
      url: relay.url,
      token: relay.token,
      cwd: dir,
      tuiRoot: dir,
      type: "call",
      id: "helper-1",
      callId: `helper-read-${process.pid}-${Date.now()}`,
      tool: "Read",
      input: { file_path: join(dir, "hello.txt") },
    }));
    proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited, `stdout=${stdout}\nstderr=${stderr}`).toBe(0);
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

async function openToolSocket(url: string, token: string, cwd: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("socket failed"));
  });
  const hello = new Promise<any>((resolve) => {
    ws.onmessage = (event) => resolve(JSON.parse(String(event.data)));
  });
  ws.send(JSON.stringify({ v: 1, type: "hello", token, cwd, tuiRoot: cwd }));
  expect((await hello).ok).toBe(true);
  return ws;
}

test("background Bash survives the plugin helper closing its socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-"));
  const relay = startRelay();
  relay.bind("s1", dir);
  try {
    const listen = await openToolSocket(relay.url, relay.token, dir);
    const notes: any[] = [];
    const exited = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("background notify timed out")), 8_000);
      listen.onmessage = (event) => {
        const frame = JSON.parse(String(event.data));
        notes.push(frame);
        if (frame.type === "notify" && frame.kind === "background" && frame.status === "exited") {
          clearTimeout(timer);
          resolve(frame);
        }
      };
    });

    const helper = join(import.meta.dir, "../plugin/hooks/ws-client.js");
    const callId = `bg-survive-${process.pid}-${Date.now()}`;
    const proc = Bun.spawn(["bun", helper], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.stdin.write(JSON.stringify({
      url: relay.url,
      token: relay.token,
      cwd: dir,
      tuiRoot: dir,
      type: "call",
      id: "bg",
      callId,
      tool: "Bash",
      input: { command: "sleep 0.35; echo survived", run_in_background: true },
    }));
    proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited, `stdout=${stdout}\nstderr=${stderr}`).toBe(0);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(result.ok).toBe(true);
    expect(result.result.backgroundTaskId).toBeDefined();

    const note = await exited;
    expect(note.callId).toBe(callId);
    expect(note.interrupted).toBe(false);
    expect(note.exitCode).toBe(0);
    expect(note.output).toContain("survived");
    listen.close();
  } finally {
    relay.stop();
  }
});

test("dropping the call socket still kills in-flight foreground Bash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-"));
  const pidFile = join(dir, "pid");
  const relay = startRelay();
  relay.bind("s1", dir);
  try {
    const ws = await openToolSocket(relay.url, relay.token, dir);
    ws.send(JSON.stringify({
      v: 1, type: "call", id: "bash", callId: `fg-drop-${process.pid}-${Date.now()}`, tool: "Bash",
      input: { command: `echo $$ > "${pidFile}"; sleep 30` },
    }));
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && !existsSync(pidFile)) await Bun.sleep(20);
    const pid = Number((await Bun.file(pidFile).text()).trim());
    expect(pid).toBeGreaterThan(1);
    ws.close();
    const gone = Date.now() + 2_000;
    let alive = true;
    while (Date.now() < gone) {
      try {
        process.kill(pid, 0);
        await Bun.sleep(20);
      } catch {
        alive = false;
        break;
      }
    }
    expect(alive).toBe(false);
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
