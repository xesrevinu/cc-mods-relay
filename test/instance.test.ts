import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.js";

function openWs(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("socket failed"));
  });
}

function nextJson(ws: WebSocket, timeoutMs = 5_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket timed out")), timeoutMs);
    ws.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(JSON.parse(String(event.data)));
      },
      { once: true },
    );
  });
}

async function startClient(server: ReturnType<typeof startServer>, cwd: string) {
  const ws = await openWs(server.sessionUrl);
  const hello = nextJson(ws);
  ws.send(JSON.stringify({ v: 1, type: "hello", token: server.token }));
  expect((await hello).ok).toBe(true);
  const ready = nextJson(ws);
  ws.send(JSON.stringify({ v: 1, type: "instance.start", cwd }));
  const started = await ready;
  expect(started.type).toBe("instance.ready");
  expect(started.instanceId).toBeTruthy();
  return { ws, started };
}

test("instance.start after hello returns ready; bad token closes; ACP before start is rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-inst-"));
  const server = startServer({ token: "secret", hostname: "127.0.0.1", port: 0, boot: false });
  try {
    const bad = await openWs(server.sessionUrl);
    const closed = new Promise<void>((resolve) => {
      bad.onclose = () => resolve();
    });
    bad.send(JSON.stringify({ v: 1, type: "hello", token: "nope" }));
    await closed;

    const anon = await openWs(server.sessionUrl);
    const unauth = nextJson(anon);
    anon.send(JSON.stringify({ v: 1, type: "instance.start", cwd: dir }));
    expect((await unauth).error.code).toBe("UNAUTHORIZED");
    anon.close();

    const early = await openWs(server.sessionUrl);
    const hello = nextJson(early);
    early.send(JSON.stringify({ v: 1, type: "hello", token: "secret" }));
    await hello;
    const before = nextJson(early);
    early.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    expect((await before).error.code).toBe("NO_INSTANCE");
    early.close();

    const { ws, started } = await startClient(server, dir);
    expect(started.tuiRoot).toBe(dir);
    expect(server.instances.has(started.instanceId)).toBe(true);
    const gone = new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (!server.instances.has(started.instanceId)) {
          clearInterval(timer);
          resolve();
        }
      }, 20);
    });
    ws.close();
    await gone;
  } finally {
    await server.stop();
  }
});

test("instance.ready tuiRoot is the client cwd when that path can be created here", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "cc-mods-tui-client-")), "project");
  const server = startServer({ token: "secret", hostname: "127.0.0.1", port: 0, boot: false });
  try {
    const ws = await openWs(server.sessionUrl);
    const hello = nextJson(ws);
    ws.send(JSON.stringify({ v: 1, type: "hello", token: "secret" }));
    expect((await hello).ok).toBe(true);
    const ready = nextJson(ws);
    ws.send(JSON.stringify({
      v: 1,
      type: "instance.start",
      cwd: dir,
      home: "/Users/alice",
    }));
    const started = await ready;
    expect(started.type).toBe("instance.ready");
    expect(started.tuiRoot).toBe(dir);
    ws.close();
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("instance.start names an empty TUI stub after the client git branch", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "cc-mods-tui-git-")), "project");
  const server = startServer({ token: "secret", hostname: "127.0.0.1", port: 0, boot: false });
  try {
    const ws = await openWs(server.sessionUrl);
    const hello = nextJson(ws);
    ws.send(JSON.stringify({ v: 1, type: "hello", token: "secret" }));
    expect((await hello).ok).toBe(true);
    const ready = nextJson(ws);
    ws.send(JSON.stringify({
      v: 1,
      type: "instance.start",
      cwd: dir,
      git: { repo: true, branch: "herdr/moonbit-migration" },
    }));
    const started = await ready;
    expect(started.type).toBe("instance.ready");
    expect(started.tuiRoot).toBe(dir);
    const ran = Bun.spawnSync(["git", "-C", dir, "symbolic-ref", "--short", "HEAD"], { stdout: "pipe" });
    const branch = Buffer.isBuffer(ran.stdout) ? ran.stdout.toString().trim() : String(ran.stdout ?? "").trim();
    expect(branch).toBe("herdr/moonbit-migration");
    ws.close();
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("instance.start leaves a non-git client cwd without .git", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "cc-mods-tui-nongit-")), "project");
  const server = startServer({ token: "secret", hostname: "127.0.0.1", port: 0, boot: false });
  try {
    const ws = await openWs(server.sessionUrl);
    const hello = nextJson(ws);
    ws.send(JSON.stringify({ v: 1, type: "hello", token: "secret" }));
    expect((await hello).ok).toBe(true);
    const ready = nextJson(ws);
    ws.send(JSON.stringify({
      v: 1,
      type: "instance.start",
      cwd: dir,
      git: { repo: false },
    }));
    const started = await ready;
    expect(started.type).toBe("instance.ready");
    expect(existsSync(join(dir, ".git"))).toBe(false);
    ws.close();
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("instance.ready tuiRoot falls back under this home when the client cwd cannot be created", async () => {
  const mapped = join(homedir(), "Workspace/cc-mods-tui-root-test");
  const server = startServer({ token: "secret", hostname: "127.0.0.1", port: 0, boot: false });
  try {
    const ws = await openWs(server.sessionUrl);
    const hello = nextJson(ws);
    ws.send(JSON.stringify({ v: 1, type: "hello", token: "secret" }));
    expect((await hello).ok).toBe(true);
    const ready = nextJson(ws);
    ws.send(JSON.stringify({
      v: 1,
      type: "instance.start",
      cwd: "/Users/someoneelse/Workspace/cc-mods-tui-root-test",
      home: "/Users/someoneelse",
    }));
    const started = await ready;
    expect(started.type).toBe("instance.ready");
    expect(started.tuiRoot).toBe(mapped);
    ws.close();
  } finally {
    await server.stop();
    rmSync(mapped, { recursive: true, force: true });
  }
});

test("instance.ready tuiRoot does not prefix Workspace for a cursor worktree fallback", async () => {
  const mapped = join(homedir(), ".cursor/worktrees/wt/cc-mods-tui-root-test");
  const server = startServer({ token: "secret", hostname: "127.0.0.1", port: 0, boot: false });
  try {
    const ws = await openWs(server.sessionUrl);
    const hello = nextJson(ws);
    ws.send(JSON.stringify({ v: 1, type: "hello", token: "secret" }));
    expect((await hello).ok).toBe(true);
    const ready = nextJson(ws);
    ws.send(JSON.stringify({
      v: 1,
      type: "instance.start",
      cwd: "/Users/someoneelse/.cursor/worktrees/wt/cc-mods-tui-root-test",
      home: "/Users/someoneelse",
    }));
    const started = await ready;
    expect(started.type).toBe("instance.ready");
    expect(started.tuiRoot).toBe(mapped);
    expect(started.tuiRoot).not.toContain("Workspace/.cursor");
    ws.close();
  } finally {
    await server.stop();
    rmSync(mapped, { recursive: true, force: true });
  }
});

test("client close then a new instance.start leaves only the new instance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-inst-"));
  const server = startServer({ token: "secret", hostname: "127.0.0.1", port: 0, boot: false });
  try {
    const first = await startClient(server, dir);
    const firstId = first.started.instanceId as string;
    expect(server.instances.size).toBe(1);
    const gone = new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (!server.instances.has(firstId)) {
          clearInterval(timer);
          resolve();
        }
      }, 20);
    });
    first.ws.close();
    await gone;
    expect(server.instances.size).toBe(0);

    const second = await startClient(server, dir);
    expect(second.started.instanceId).not.toBe(firstId);
    expect(server.instances.size).toBe(1);
    expect(server.instances.has(second.started.instanceId)).toBe(true);
    expect(server.instances.has(firstId)).toBe(false);
    second.ws.close();
  } finally {
    await server.stop();
  }
});

test("disconnect during start aborts boot and a later client can start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-inst-"));
  let release!: () => void;
  const pauseStart = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = startServer({ token: "secret", hostname: "127.0.0.1", port: 0, boot: false, pauseStart });
  try {
    const ws = await openWs(server.sessionUrl);
    ws.send(JSON.stringify({ v: 1, type: "hello", token: "secret" }));
    expect((await nextJson(ws)).ok).toBe(true);
    ws.send(JSON.stringify({ v: 1, type: "instance.start", cwd: dir }));
    const hangingId = await (async () => {
      for (let i = 0; i < 50; i++) {
        const id = [...server.instances.keys()][0];
        if (id) return id;
        await Bun.sleep(10);
      }
      throw new Error("instance never registered");
    })();
    ws.close();
    for (let i = 0; i < 50 && server.instances.size > 0; i++) await Bun.sleep(10);
    expect(server.instances.size).toBe(0);
    release();
    await Bun.sleep(20);
    expect(server.instances.size).toBe(0);
    expect(server.instances.has(hangingId)).toBe(false);

    const next = await startClient(server, dir);
    expect(next.started.instanceId).not.toBe(hangingId);
    expect(server.instances.size).toBe(1);
    next.ws.close();
  } finally {
    release();
    await server.stop();
  }
});

test("plugin loopback call is forwarded to the client WS and the result comes back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-inst-"));
  writeFileSync(join(dir, "hello.txt"), "hello\n");
  const server = startServer({ token: "secret", hostname: "127.0.0.1", port: 0, boot: false });
  try {
    const { ws, started } = await startClient(server, dir);
    const inst = server.instances.get(started.instanceId)!;
    const plugin = await openWs(server.toolsUrl);
    const phello = nextJson(plugin);
    plugin.send(JSON.stringify({ v: 1, type: "hello", token: inst.pluginToken, cwd: dir, tuiRoot: dir }));
    expect((await phello).ok).toBe(true);

    const clientCall = nextJson(ws);
    plugin.send(JSON.stringify({
      v: 1,
      type: "call",
      id: "1",
      callId: "inst-c1",
      tool: "Read",
      input: { file_path: join(dir, "hello.txt") },
    }));
    const call = await clientCall;
    expect(call.type).toBe("call");
    expect(call.callId).toBe("inst-c1");
    expect(call.tool).toBe("Read");

    const result = nextJson(plugin);
    ws.send(JSON.stringify({
      v: 1,
      type: "result",
      id: "1",
      callId: "inst-c1",
      ok: true,
      result: { type: "text", file: { content: "hello\n" } },
    }));
    const body = await result;
    expect(body.ok).toBe(true);
    expect(body.result.file.content).toContain("hello");
    ws.close();
    plugin.close();
  } finally {
    await server.stop();
  }
});

test("plugin helper close after a result does not cancel the call on the client", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-inst-"));
  const server = startServer({ token: "secret", hostname: "127.0.0.1", port: 0, boot: false });
  try {
    const { ws, started } = await startClient(server, dir);
    const inst = server.instances.get(started.instanceId)!;
    const plugin = await openWs(server.toolsUrl);
    const phello = nextJson(plugin);
    plugin.send(JSON.stringify({ v: 1, type: "hello", token: inst.pluginToken, cwd: dir, tuiRoot: dir }));
    expect((await phello).ok).toBe(true);

    const clientCall = nextJson(ws);
    plugin.send(JSON.stringify({
      v: 1, type: "call", id: "bg", callId: "bg-1", tool: "Bash",
      input: { command: "sleep 30", run_in_background: true },
    }));
    expect((await clientCall).callId).toBe("bg-1");

    const result = nextJson(plugin);
    ws.send(JSON.stringify({
      v: 1, type: "result", id: "bg", callId: "bg-1", ok: true,
      result: { stdout: "running", stderr: "", interrupted: false, backgroundTaskId: "9" },
    }));
    expect((await result).ok).toBe(true);

    const cancelled = new Promise<any>((resolve) => {
      ws.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data));
        if (frame.type === "cancel") resolve(frame);
      });
    });
    plugin.close();
    const raced = await Promise.race([cancelled, Bun.sleep(200).then(() => null)]);
    expect(raced).toBeNull();
    ws.close();
  } finally {
    await server.stop();
  }
});

test("dropping the plugin socket before a result still cancels the in-flight call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-inst-"));
  const server = startServer({ token: "secret", hostname: "127.0.0.1", port: 0, boot: false });
  try {
    const { ws, started } = await startClient(server, dir);
    const inst = server.instances.get(started.instanceId)!;
    const plugin = await openWs(server.toolsUrl);
    const phello = nextJson(plugin);
    plugin.send(JSON.stringify({ v: 1, type: "hello", token: inst.pluginToken, cwd: dir, tuiRoot: dir }));
    expect((await phello).ok).toBe(true);

    const clientCall = nextJson(ws);
    plugin.send(JSON.stringify({
      v: 1, type: "call", id: "fg", callId: "fg-1", tool: "Bash",
      input: { command: "sleep 30" },
    }));
    expect((await clientCall).callId).toBe("fg-1");

    const cancelled = nextJson(ws);
    plugin.close();
    const frame = await cancelled;
    expect(frame.type).toBe("cancel");
    expect(frame.callId).toBe("fg-1");
    ws.close();
  } finally {
    await server.stop();
  }
});

test("plugin cancel without sessionId is stamped with the instance id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-inst-"));
  const server = startServer({ token: "secret", hostname: "127.0.0.1", port: 0, boot: false });
  try {
    const { ws, started } = await startClient(server, dir);
    const inst = server.instances.get(started.instanceId)!;
    const plugin = await openWs(server.toolsUrl);
    const phello = nextJson(plugin);
    plugin.send(JSON.stringify({ v: 1, type: "hello", token: inst.pluginToken, cwd: dir, tuiRoot: dir }));
    expect((await phello).ok).toBe(true);

    const cancelled = nextJson(ws);
    plugin.send(JSON.stringify({ v: 1, type: "cancel" }));
    const frame = await cancelled;
    expect(frame.type).toBe("cancel");
    expect(frame.sessionId).toBe(inst.id);
    ws.close();
    plugin.close();
  } finally {
    await server.stop();
  }
});
