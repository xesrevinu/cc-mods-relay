#!/usr/bin/env bun
/**
 * Out-of-sandbox WebSocket client. Mods cannot open a WebSocket or set a timer;
 * this process is started with $.process.run / $.process.spawn.
 *
 * stdin: one JSON object. stdout: one JSON object, or JSONL in listen mode.
 * Always prints a result frame on failure so the plugin can return an error
 * instead of falling through to a native Mini tool.
 */
const raw = await Bun.stdin.text();
const msg = JSON.parse(raw);
const url = msg.url;
if (!url || typeof url !== "string" || !url.startsWith("ws://127.0.0.1")) {
  fail("INVALID_REQUEST", "loopback WebSocket url required");
}

function fail(code, message) {
  console.log(JSON.stringify({
    v: 1,
    type: "result",
    id: msg.id,
    callId: msg.callId,
    sessionId: msg.sessionId,
    ok: false,
    error: { code, message },
  }));
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function attach(ws) {
  const pending = [];
  const waiters = [];
  const failWaiters = (error) => {
    while (waiters.length) waiters.shift().reject(error);
  };
  ws.onmessage = (event) => {
    const frame = JSON.parse(String(event.data));
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(frame);
    else pending.push(frame);
  };
  ws.onerror = () => failWaiters(new Error("WebSocket failed"));
  ws.onclose = () => failWaiters(new Error("WebSocket closed"));
  return () => new Promise((resolve, reject) => {
    if (pending.length) return resolve(pending.shift());
    waiters.push({ resolve, reject });
  });
}

async function openSocket(timeoutMs) {
  const ws = new WebSocket(url);
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket connect timed out")), timeoutMs);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("WebSocket failed"));
    };
  });
  await opened;
  return ws;
}

async function connect(attempts = 5) {
  let last = new Error("WebSocket failed");
  for (let i = 0; i < attempts; i++) {
    try {
      const ws = await openSocket(3_000);
      try {
        const read = attach(ws);
        const send = (frame) => ws.send(JSON.stringify(frame));
        send({ v: 1, type: "hello", token: msg.token, cwd: msg.cwd, tuiRoot: msg.tuiRoot, extraDirs: msg.extraDirs });
        const hello = await Promise.race([
          read(),
          sleep(5_000).then(() => Promise.reject(new Error("hello timed out"))),
        ]);
        if (!hello.ok) throw new Error(hello.error?.message || "hello rejected");
        return { ws, read, send, hello };
      } catch (error) {
        try { ws.close(); } catch { /* ignore */ }
        throw error;
      }
    } catch (error) {
      last = error instanceof Error ? error : new Error(String(error));
      await sleep(200 * (i + 1));
    }
  }
  throw last;
}

if (msg.type === "listen") {
  for (;;) {
    try {
      const { read } = await connect(8);
      for (;;) {
        const frame = await read();
        if (frame.type === "notify") console.log(JSON.stringify(frame));
      }
    } catch {
      await sleep(500);
    }
  }
}

const attempts = msg.type === "hello" ? 8 : msg.type === "cancel" ? 2 : 5;
let session;
try {
  session = await connect(attempts);
} catch (error) {
  fail("EXECUTOR_DISCONNECTED", error instanceof Error ? error.message : String(error));
}

if (msg.type === "hello") {
  console.log(JSON.stringify(session.hello));
  session.ws.close();
  process.exit(0);
}

if (msg.type === "turn.complete" || msg.type === "turn.start" || msg.type === "cancel") {
  session.send({ v: 1, type: msg.type, callId: msg.callId, sessionId: msg.sessionId, answer: msg.answer, isAborted: msg.isAborted });
  session.ws.close();
  process.exit(0);
}

session.send({
  v: 1,
  type: msg.type || "call",
  id: msg.id,
  callId: msg.callId,
  sessionId: msg.sessionId,
  tool: msg.tool,
  input: msg.input,
  cwd: msg.cwd,
  tuiRoot: msg.tuiRoot,
  extraDirs: msg.extraDirs,
});
try {
  let frame;
  for (;;) {
    frame = await session.read();
    if (frame.type === "result") break;
  }
  console.log(JSON.stringify(frame));
  session.ws.close();
  process.exit(frame.ok === false ? 1 : 0);
} catch (error) {
  fail("EXECUTOR_DISCONNECTED", error instanceof Error ? error.message : String(error));
}
