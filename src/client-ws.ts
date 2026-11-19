import { collectForwardedEnv } from "./forwarded-env.js";
import { readClientGit } from "./git-stub.js";
import { collectHomeFiles, collectSessionFiles, rememberSessionSync, selectSyncFiles } from "./launch.js";
import { applyTranscriptFrame, loadTranscriptCursors } from "./transcript-mirror.js";
import { backfillTranscripts } from "./transcript-backfill.js";
import { classify, parseWsJson, readNdjsonStream } from "./mux.js";
import { configuredHost, configuredToken, configuredUrl, httpUrlFromWs } from "./config.js";
import { startServer } from "./server.js";
import { createToolExecutor } from "./tool-executor.js";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

export type ClientWsOpts = {
  url: string;
  token: string;
  cwd?: string;
  tuiRoot?: string;
  extraDirs?: string[];
  env?: NodeJS.ProcessEnv;
  heartbeatMs?: number;
};

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** Force-tear down a half-open / blackholed TCP WebSocket without waiting for a Close frame. */
function forceClose(ws: WebSocket, code = 4000, reason = "reconnect") {
  try {
    const bunWs = ws as WebSocket & { terminate?: () => void };
    if (typeof bunWs.terminate === "function") {
      bunWs.terminate();
      return;
    }
    ws.close(code, reason);
  } catch {
    /* already closed */
  }
}

function waitOpen(ws: WebSocket, timeoutMs = 10_000): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error("websocket connect timed out"));
    }, timeoutMs);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      fn();
    };
    ws.addEventListener("open", () => done(resolve), { once: true });
    ws.addEventListener("error", () => done(() => reject(new Error("websocket failed"))), { once: true });
    ws.addEventListener("close", () => done(() => reject(new Error("websocket closed"))), { once: true });
  });
}

function waitCtrl(ws: WebSocket, type: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${type} timed out`)), timeoutMs);
    const done = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
    };
    const onClose = () => {
      done();
      reject(new Error("websocket closed"));
    };
    const onMessage = (event: MessageEvent) => {
      let msg: unknown;
      try {
        msg = parseWsJson(String(event.data));
      } catch {
        return;
      }
      if (classify(msg) !== "ctrl") return;
      const row = msg as { type?: string };
      if (row.type !== type && row.type !== "instance.error") return;
      done();
      if (row.type === "instance.error") {
        const err = (msg as { error?: { message?: string } }).error?.message ?? "instance error";
        reject(new Error(err));
        return;
      }
      resolve(msg as Record<string, unknown>);
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
  });
}

export async function runClientWs(opts: ClientWsOpts): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  let activeWs = new WebSocket(opts.url);
  let attachingWs: WebSocket | undefined;
  const executor = createToolExecutor();
  executor.bind("", cwd, opts.tuiRoot ?? cwd, opts.extraDirs ?? []);
  const pendingOutbound: unknown[] = [];
  let reconnecting = false;
  let stdinEnded = false;
  let lastServerSeq = 0;
  let lastRecvAt = Date.now();
  const heartbeatMs = opts.heartbeatMs ?? 10_000;

  const enqueueOutbound = (msg: unknown) => {
    if (!reconnecting && activeWs.readyState === WebSocket.OPEN) {
      send(activeWs, msg);
      return;
    }
    if (stdinEnded) return;
    const kind = (msg as { type?: string } | null)?.type;
    if (kind === "transcript.flush") return;
    if (pendingOutbound.length >= 1024) {
      const dropIdx = pendingOutbound.findIndex((item) => {
        const t = (item as { type?: string } | null)?.type;
        return t !== "result" && t !== "notify";
      });
      pendingOutbound.splice(dropIdx >= 0 ? dropIdx : 0, 1);
    }
    pendingOutbound.push(msg);
  };

  const outbound = (msg: unknown) => enqueueOutbound(msg);
  const broadcast = (msg: unknown) => enqueueOutbound(msg);

  const loopback = (() => {
    try {
      const hostname = new URL(opts.url).hostname;
      return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
    } catch {
      return false;
    }
  })();
  const host = loopback ? undefined : await configuredHost();

  await waitOpen(activeWs);

  let idleFlush: ReturnType<typeof setTimeout> | undefined;
  const flushNow = () => {
    if (activeWs.readyState === WebSocket.OPEN && activeWs.bufferedAmount <= 2 * 1024 * 1024) {
      send(activeWs, { v: 1, type: "transcript.flush", transcriptCursors: loadTranscriptCursors() });
    }
  };
  const requestFlush = (delayMs = 0) => {
    if (delayMs <= 0) {
      flushNow();
      return;
    }
    if (idleFlush) clearTimeout(idleFlush);
    idleFlush = setTimeout(() => {
      idleFlush = undefined;
      flushNow();
    }, delayMs);
  };
  executor.onTurn(() => {
    requestFlush(0);
    requestFlush(1_000);
  });

  const wireMessages = (ws: WebSocket) => {
    ws.addEventListener("message", (event) => {
      if (ws !== activeWs && ws !== attachingWs) return;
      lastRecvAt = Date.now();
      let msg: unknown;
      try {
        msg = parseWsJson(String(event.data));
      } catch {
        return;
      }
      const kind = classify(msg);
      if (kind === "acp") {
        process.stdout.write(`${JSON.stringify(msg)}\n`);
        return;
      }
      const frame = msg as { type?: string; seq?: unknown; msg?: unknown; rel?: unknown; offset?: unknown; data?: unknown };
      if (frame.type === "pong") return;
      if (typeof frame.seq === "number" && Number.isFinite(frame.seq)) {
        if (frame.seq <= lastServerSeq) return;
        lastServerSeq = frame.seq;
      }
      if (frame.type === "acp") {
        if (frame.msg !== undefined) process.stdout.write(`${JSON.stringify(frame.msg)}\n`);
        return;
      }
      if (frame.type === "transcript.append") {
        const applied = applyTranscriptFrame(frame);
        if (!applied && typeof frame.offset === "number" && frame.offset > 0) requestFlush(0);
        return;
      }
      if (
        frame.type === "call" ||
        frame.type === "cancel" ||
        frame.type === "aliasTask" ||
        frame.type === "turn.start" ||
        frame.type === "turn.complete"
      ) {
        executor.handle(frame, outbound, broadcast);
      }
    });
  };
  wireMessages(activeWs);

  const hello = waitCtrl(activeWs, "hello");
  send(activeWs, { v: 1, type: "hello", token: opts.token });
  await hello;

  const ready = waitCtrl(activeWs, "instance.ready", 60_000);
  const home = homedir();
  const sync = selectSyncFiles(opts.url, cwd, home, collectSessionFiles(cwd), collectHomeFiles(home));
  send(activeWs, {
    v: 1,
    type: "instance.start",
    cwd,
    home,
    tuiRoot: opts.tuiRoot,
    extraDirs: opts.extraDirs ?? [],
    reconnectGraceMs: 60_000,
    seqReplay: true,
    env: collectForwardedEnv(env),
    git: readClientGit(cwd),
    transcriptCursors: loadTranscriptCursors(),
    ...(sync.files ? { files: sync.files } : {}),
    ...(sync.homeFiles ? { homeFiles: sync.homeFiles } : {}),
  });
  const started = await ready;
  rememberSessionSync(opts.url, cwd, home, sync.projectHash, sync.homeHash);
  const instanceId = typeof started.instanceId === "string" ? started.instanceId : "";
  const resumeToken = typeof started.resumeToken === "string" ? started.resumeToken : "";
  const tuiRoot = typeof started.tuiRoot === "string" && started.tuiRoot ? started.tuiRoot : opts.tuiRoot ?? cwd;
  executor.bind(instanceId, cwd, tuiRoot, opts.extraDirs ?? []);
  if (host) {
    void backfillTranscripts({ host })
      .then(() => requestFlush(0))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`cc-mods-relay: transcript rsync-backfill failed: ${message}`);
      });
  }

  const waitClosed = (ws: WebSocket) =>
    new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      ws.addEventListener("close", () => resolve(), { once: true });
      ws.addEventListener("error", () => resolve(), { once: true });
    });

  const reading = readNdjsonStream(Bun.stdin.stream(), (msg) => {
    if (classify(msg) === "acp") enqueueOutbound(msg);
  }).finally(() => {
    stdinEnded = true;
  });

  const tryReattach = async (): Promise<boolean> => {
    if (!instanceId || !resumeToken || stdinEnded) return false;
    reconnecting = true;
    forceClose(activeWs, 4000, "reattach");
    const delays = [250, 500, 1_000, 2_000, 3_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000];
    const deadline = Date.now() + 55_000;
    for (const delay of delays) {
      if (stdinEnded || Date.now() >= deadline) break;
      await Bun.sleep(delay);
      if (stdinEnded) break;
      const candidate = new WebSocket(opts.url);
      attachingWs = candidate;
      try {
        await waitOpen(candidate, 5_000);
        wireMessages(candidate);
        const h = waitCtrl(candidate, "hello", 5_000);
        send(candidate, { v: 1, type: "hello", token: opts.token });
        await h;
        const att = waitCtrl(candidate, "instance.ready", 10_000);
        send(candidate, { v: 1, type: "instance.attach", instanceId, resumeToken, lastSeq: lastServerSeq });
        await att;
        activeWs = candidate;
        attachingWs = undefined;
        lastRecvAt = Date.now();
        reconnecting = false;
        while (pendingOutbound.length && activeWs.readyState === WebSocket.OPEN) {
          send(activeWs, pendingOutbound[0]);
          pendingOutbound.shift();
        }
        requestFlush(0);
        return true;
      } catch {
        if (attachingWs === candidate) attachingWs = undefined;
        try { candidate.close(); } catch { /* ignore */ }
      }
    }
    reconnecting = false;
    return false;
  };

  // Tailscale / WAN silent blackhole detector + seq ack trimmer.
  const heartbeat = heartbeatMs > 0
    ? setInterval(() => {
        if (stdinEnded || reconnecting || activeWs.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastRecvAt > heartbeatMs * 2.5) {
          console.error("cc-mods-relay: session heartbeat timed out; reconnecting");
          forceClose(activeWs, 4000, "heartbeat-timeout");
          return;
        }
        send(activeWs, { v: 1, type: "ping", ts: Date.now(), ack: lastServerSeq });
      }, heartbeatMs)
    : undefined;
  heartbeat?.unref?.();

  for (;;) {
    const closed = waitClosed(activeWs);
    const winner = await Promise.race([
      closed.then(() => "closed" as const),
      reading.then(() => "eof" as const),
    ]);
    if (winner === "eof") break;
    if (!(await tryReattach())) break;
  }

  if (heartbeat) clearInterval(heartbeat);
  if (idleFlush) clearTimeout(idleFlush);
  requestFlush(0);
  executor.cancelAll();
  try {
    activeWs.close(stdinEnded ? 1000 : 1001, stdinEnded ? "eof" : "disconnect");
  } catch {
    /* already closed */
  }
}

export async function runLocal(): Promise<void> {
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  console.debug = console.error;
  const token = (await configuredToken()) ?? randomUUID();
  const server = startServer({ token, hostname: "127.0.0.1", port: 0 });
  const stop = () => void server.stop();
  process.on("exit", stop);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await runClientWs({ url: server.sessionUrl, token });
}

export async function runClient(url: string, token: string): Promise<void> {
  await runClientWs({ url, token });
}

export async function doctor(url: string): Promise<void> {
  const health = httpUrlFromWs(url);
  const res = await fetch(health);
  if (!res.ok) {
    console.error(`cc-mods-relay: doctor failed (${res.status})`);
    process.exit(1);
  }
  const body = (await res.json()) as { claude?: string | null; bun?: string | null; herdr?: string | null };
  console.log(`claude ${body.claude ?? "?"}`);
  console.log(`bun ${body.bun ?? "?"}`);
  console.log(`herdr ${body.herdr ?? "?"}`);
  process.exit(0);
}

export { configuredUrl };
