#!/usr/bin/env bun
/**
 * Persistent WebSocket + local Unix-socket RPC helper. Mods cannot open a
 * WebSocket or set a timer; `register.js` runs one long-lived `listen`
 * process here for the session and falls back to one-shot spawns if needed.
 *
 * stdin: one JSON object. stdout: one JSON object, or JSONL in listen mode.
 */
import { unlinkSync } from "node:fs";

const raw = await Bun.stdin.text();
const msg = JSON.parse(raw);
const url = msg.url;
if (!url || typeof url !== "string" || !url.startsWith("ws://127.0.0.1")) {
  fail("INVALID_REQUEST", "loopback WebSocket url required");
}

const SHELL_TOOLS = new Set(["Bash", "Monitor", "PowerShell"]);
const RPC_SLICE_MS = 20_000;

const TUI_LOCALE_KEYS = [
  "TZ",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_TIME",
  "LC_MESSAGES",
  "LC_COLLATE",
  "LC_NUMERIC",
  "LC_MONETARY",
];
const TUI_DISPLAY_KEYS = ["TERM", "COLORTERM", "FORCE_COLOR"];

function zoneFromPath(text) {
  const match = String(text).trim().match(/zoneinfo\/([A-Za-z][A-Za-z0-9+_/-]*)$/);
  return match ? match[1] : "";
}

function detectTz() {
  const envTz = typeof process.env.TZ === "string" ? process.env.TZ.trim() : "";
  if (envTz) return envTz;
  for (const argv of [["readlink", "/etc/localtime"], ["realpath", "/etc/localtime"]]) {
    try {
      const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
      const zone = zoneFromPath(new TextDecoder().decode(result.stdout));
      if (zone) return zone;
    } catch {
      /* try the next probe */
    }
  }
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof zone === "string" && zone.trim()) return zone.trim();
  } catch {
    /* ICU missing */
  }
  return "";
}

function posixLocale(raw) {
  const token = String(raw).trim().split("@")[0] || "";
  const match = token.match(/^([A-Za-z]{2})[-_]([A-Za-z0-9]+)$/);
  return match ? `${match[1]}_${match[2]}.UTF-8` : "";
}

function detectLang() {
  const envLang = typeof process.env.LANG === "string" ? process.env.LANG.trim() : "";
  if (envLang) return envLang;
  try {
    const result = Bun.spawnSync(["defaults", "read", "-g", "AppleLocale"], { stdout: "pipe", stderr: "pipe" });
    const lang = posixLocale(new TextDecoder().decode(result.stdout));
    if (lang) return lang;
  } catch {
    /* non-macOS or defaults missing */
  }
  try {
    const lang = posixLocale(Intl.DateTimeFormat().resolvedOptions().locale);
    if (lang) return lang;
  } catch {
    /* ICU missing */
  }
  return "";
}

function parseOverride(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = {};
    for (const key of [...TUI_LOCALE_KEYS, ...TUI_DISPLAY_KEYS]) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) out[key] = value.trim();
    }
    return out;
  } catch {
    return {};
  }
}

function collectTuiEnv() {
  const override = parseOverride(process.env.CC_MODS_TUI_ENV);
  const out = { ...override };
  if (Object.keys(override).length) {
    if (!out.TZ) {
      const tz = detectTz();
      if (tz) out.TZ = tz;
    }
    if (!out.LANG) {
      const lang = detectLang();
      if (lang) out.LANG = lang;
    }
    return out;
  }
  for (const key of TUI_LOCALE_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  if (!out.TZ) {
    const tz = detectTz();
    if (tz) out.TZ = tz;
  }
  if (!out.LANG) {
    const lang = detectLang();
    if (lang) out.LANG = lang;
  }
  for (const key of TUI_DISPLAY_KEYS) {
    if (out[key]) continue;
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return out;
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

async function connect(attempts = 5, tuiEnv) {
  let last = new Error("WebSocket failed");
  for (let i = 0; i < attempts; i++) {
    try {
      const ws = await openSocket(3_000);
      try {
        const read = attach(ws);
        const send = (frame) => ws.send(JSON.stringify(frame));
        send({
          v: 1,
          type: "hello",
          token: msg.token,
          cwd: msg.cwd,
          tuiRoot: msg.tuiRoot,
          extraDirs: msg.extraDirs,
          ...(tuiEnv ? { tuiEnv } : {}),
        });
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

function unlinkQuiet(path) {
  if (!path) return;
  try { unlinkSync(path); } catch { /* ignore */ }
}

function runListener() {
  const cachedTuiEnv = collectTuiEnv();
  const calls = new Map();
  let active = null;

  const rejectPending = (message) => {
    const err = new Error(message);
    for (const [callId, entry] of calls) {
      if (entry.frame || entry.error) continue;
      entry.error = err;
      const hadWaiters = entry.waiters.length > 0;
      while (entry.waiters.length) entry.waiters.shift().reject(err);
      if (!hadWaiters) {
        const timer = setTimeout(() => {
          if (calls.get(callId) === entry) calls.delete(callId);
        }, 30_000);
        timer.unref?.();
      }
    }
  };

  const waitSlice = async (callId, entry, sliceMs = RPC_SLICE_MS) => {
    if (entry.frame) {
      calls.delete(callId);
      return entry.frame;
    }
    if (entry.error) {
      calls.delete(callId);
      throw entry.error;
    }
    const waitMs = Math.max(200, Math.min(RPC_SLICE_MS, Number.isFinite(sliceMs) && sliceMs > 0 ? sliceMs : RPC_SLICE_MS));
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve(frame) {
          clearTimeout(timer);
          calls.delete(callId);
          resolve(frame);
        },
        reject(error) {
          clearTimeout(timer);
          calls.delete(callId);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        const idx = entry.waiters.indexOf(waiter);
        if (idx >= 0) entry.waiters.splice(idx, 1);
        resolve({ pending: true, callId });
      }, waitMs);
      timer.unref?.();
      entry.waiters.push(waiter);
    });
  };

  let rpcServer = null;
  if (typeof msg.rpcSocket === "string" && msg.rpcSocket) {
    unlinkQuiet(msg.rpcSocket);
    rpcServer = Bun.serve({
      unix: msg.rpcSocket,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        const body = await req.json().catch(() => null);
        if (!body || typeof body !== "object") {
          return Response.json({ ok: false, error: { code: "INVALID_REQUEST", message: "bad JSON" } }, { status: 400 });
        }
        if (path === "/wait") {
          const callId = typeof body.callId === "string" ? body.callId : "";
          const entry = callId ? calls.get(callId) : undefined;
          if (!entry) {
            return Response.json(
              { v: 1, type: "result", callId, ok: false, error: { code: "EXECUTOR_DISCONNECTED", message: "call lost" } },
              { status: 502 },
            );
          }
          try {
            return Response.json(await waitSlice(callId, entry, Number(body.sliceMs)));
          } catch (error) {
            return Response.json(
              {
                v: 1,
                type: "result",
                callId,
                ok: false,
                error: { code: "EXECUTOR_DISCONNECTED", message: error instanceof Error ? error.message : String(error) },
              },
              { status: 502 },
            );
          }
        }
        if (path !== "/rpc") return new Response("not found", { status: 404 });
        if (!active) {
          return Response.json({ ok: false, error: { code: "NO_CONNECTION", message: "listener reconnecting" } }, { status: 503 });
        }
        const kind = body.type || "call";
        if (kind === "turn.complete" || kind === "turn.start" || kind === "cancel" || kind === "aliasTask") {
          try {
            active.send({
              v: 1,
              type: kind,
              callId: body.callId,
              taskId: body.taskId,
              scope: body.scope,
              sessionId: body.sessionId,
              agentId: body.agentId,
              answer: body.answer,
              isAborted: body.isAborted,
            });
            return Response.json({ ok: true });
          } catch {
            return Response.json({ ok: false, error: { code: "NO_CONNECTION", message: "send failed" } }, { status: 503 });
          }
        }
        const callId = typeof body.callId === "string" ? body.callId : typeof body.id === "string" ? body.id : "";
        const sig = JSON.stringify({ tool: body.tool, input: body.input });
        let entry = callId ? calls.get(callId) : undefined;
        if (entry && entry.sig !== sig) {
          return Response.json({
            v: 1,
            type: "result",
            id: body.id,
            callId,
            sessionId: body.sessionId,
            ok: false,
            error: { code: "CALL_ID_CONFLICT", message: "callId reused with different input" },
          });
        }
        if (!entry) {
          entry = { sig, waiters: [] };
          if (callId) calls.set(callId, entry);
          try {
            active.send({
              v: 1,
              type: "call",
              id: body.id,
              callId,
              sessionId: body.sessionId,
              claudeSessionId: body.claudeSessionId,
              agentId: body.agentId,
              tuiUid: body.tuiUid,
              ...(SHELL_TOOLS.has(body.tool) ? { tuiEnv: cachedTuiEnv } : {}),
              tool: body.tool,
              input: body.input,
              cwd: body.cwd || msg.cwd,
              tuiRoot: body.tuiRoot || msg.tuiRoot,
              extraDirs: body.extraDirs ?? msg.extraDirs,
            });
          } catch {
            if (callId) calls.delete(callId);
            return Response.json({ ok: false, error: { code: "NO_CONNECTION", message: "send failed" } }, { status: 503 });
          }
        }
        try {
          return Response.json(await waitSlice(callId, entry, Number(body.sliceMs)));
        } catch (error) {
          return Response.json(
            {
              v: 1,
              type: "result",
              id: body.id,
              callId,
              sessionId: body.sessionId,
              ok: false,
              error: { code: "EXECUTOR_DISCONNECTED", message: error instanceof Error ? error.message : String(error) },
            },
            { status: 502 },
          );
        }
      },
    });
    const cleanup = () => {
      try { rpcServer?.stop(true); } catch { /* ignore */ }
      unlinkQuiet(msg.rpcSocket);
    };
    process.on("exit", cleanup);
    process.on("SIGTERM", () => { cleanup(); process.exit(0); });
    process.on("SIGINT", () => { cleanup(); process.exit(0); });
  }

  return (async () => {
    for (;;) {
      try {
        const session = await connect(8, cachedTuiEnv);
        active = session;
        try { session.send({ v: 1, type: "listen" }); } catch { /* ignore */ }
        for (;;) {
          const frame = await session.read();
          if (frame.type === "notify") {
            console.log(JSON.stringify(frame));
            continue;
          }
          if (frame.type === "result" && typeof frame.callId === "string") {
            const entry = calls.get(frame.callId);
            if (entry) {
              entry.frame = frame;
              const hadWaiters = entry.waiters.length > 0;
              while (entry.waiters.length) entry.waiters.shift().resolve(frame);
              if (!hadWaiters) {
                const timer = setTimeout(() => {
                  if (calls.get(frame.callId) === entry) calls.delete(frame.callId);
                }, 30_000);
                timer.unref?.();
              }
            }
          }
        }
      } catch {
        active = null;
        rejectPending("EXECUTOR_DISCONNECTED");
        await sleep(500);
      }
    }
  })();
}

if (msg.type === "listen") {
  await runListener();
}

const attempts = msg.type === "hello" ? 8 : msg.type === "cancel" ? 2 : 5;
const needEnv = msg.type === "hello" || SHELL_TOOLS.has(msg.tool);
let session;
try {
  session = await connect(attempts, needEnv ? collectTuiEnv() : undefined);
} catch (error) {
  fail("EXECUTOR_DISCONNECTED", error instanceof Error ? error.message : String(error));
}

if (msg.type === "hello") {
  console.log(JSON.stringify(session.hello));
  session.ws.close();
  process.exit(0);
}

if (msg.type === "turn.complete" || msg.type === "turn.start" || msg.type === "cancel" || msg.type === "aliasTask") {
  session.send({
    v: 1,
    type: msg.type,
    callId: msg.callId,
    taskId: msg.taskId,
    scope: msg.scope,
    sessionId: msg.sessionId,
    agentId: msg.agentId,
    answer: msg.answer,
    isAborted: msg.isAborted,
  });
  session.ws.close();
  process.exit(0);
}

session.send({
  v: 1,
  type: msg.type || "call",
  id: msg.id,
  callId: msg.callId,
  sessionId: msg.sessionId,
  claudeSessionId: msg.claudeSessionId,
  agentId: msg.agentId,
  tuiUid: msg.tuiUid,
  ...(SHELL_TOOLS.has(msg.tool) ? { tuiEnv: collectTuiEnv() } : {}),
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
