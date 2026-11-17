import { collectForwardedEnv } from "./forwarded-env.js";
import { readClientGit } from "./git-stub.js";
import { collectHomeFiles, collectSessionFiles, rememberSessionSync, selectSyncFiles } from "./launch.js";
import { applyTranscriptFrame, loadTranscriptCursors } from "./transcript-mirror.js";
import { backfillTranscripts } from "./transcript-backfill.js";
import { classify, parseWsJson, readNdjsonStream } from "./mux.js";
import { configuredHost, configuredToken, configuredUrl, httpUrlFromWs } from "./config.js";
import { debug } from "./debug.js";
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
};

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function waitOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("websocket failed")), { once: true });
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
  const ws = new WebSocket(opts.url);
  const executor = createToolExecutor();
  executor.bind("", cwd, opts.tuiRoot ?? cwd, opts.extraDirs ?? []);

  const outbound = (msg: unknown) => send(ws, msg);
  const broadcast = (msg: unknown) => send(ws, msg);

  const loopback = (() => {
    try {
      const hostname = new URL(opts.url).hostname;
      return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
    } catch {
      return false;
    }
  })();
  const host = loopback ? undefined : await configuredHost();
  if (host) {
    try {
      await backfillTranscripts({ host });
    } catch (error) {
      debug("transcript rsync-backfill skipped", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  await waitOpen(ws);

  let idleFlush: ReturnType<typeof setTimeout> | undefined;
  const requestFlush = (delayMs = 0) => {
    if (delayMs <= 0) {
      send(ws, { v: 1, type: "transcript.flush" });
      return;
    }
    if (idleFlush) clearTimeout(idleFlush);
    idleFlush = setTimeout(() => {
      idleFlush = undefined;
      send(ws, { v: 1, type: "transcript.flush" });
    }, delayMs);
  };
  executor.onTurn((frame) => {
    if (frame.type === "turn.start") {
      if (idleFlush) clearTimeout(idleFlush);
      idleFlush = undefined;
      return;
    }
    if (frame.type === "turn.complete") requestFlush(0);
    requestFlush(1_000);
  });

  ws.addEventListener("message", (event) => {
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
    const frame = msg as { type?: string; rel?: unknown; offset?: unknown; data?: unknown };
    if (frame.type === "transcript.append") {
      applyTranscriptFrame(frame);
      return;
    }
    if (frame.type === "call" || frame.type === "cancel" || frame.type === "turn.start" || frame.type === "turn.complete") {
      executor.handle(frame, outbound, broadcast);
    }
  });

  const hello = waitCtrl(ws, "hello");
  send(ws, { v: 1, type: "hello", token: opts.token });
  await hello;

  const ready = waitCtrl(ws, "instance.ready", 60_000);
  const home = homedir();
  const sync = selectSyncFiles(opts.url, cwd, home, collectSessionFiles(cwd), collectHomeFiles(home));
  send(ws, {
    v: 1,
    type: "instance.start",
    cwd,
    home,
    tuiRoot: opts.tuiRoot,
    extraDirs: opts.extraDirs ?? [],
    env: collectForwardedEnv(env),
    git: readClientGit(cwd),
    transcriptCursors: loadTranscriptCursors(),
    ...(sync.files ? { files: sync.files } : {}),
    ...(sync.homeFiles ? { homeFiles: sync.homeFiles } : {}),
  });
  const started = await ready;
  rememberSessionSync(opts.url, cwd, home, sync.projectHash, sync.homeHash);
  const tuiRoot = typeof started.tuiRoot === "string" && started.tuiRoot ? started.tuiRoot : opts.tuiRoot ?? cwd;
  executor.bind("", cwd, tuiRoot, opts.extraDirs ?? []);

  const closed = new Promise<void>((resolve) => {
    ws.addEventListener("close", () => resolve());
    ws.addEventListener("error", () => resolve());
  });

  const reading = readNdjsonStream(Bun.stdin.stream(), (msg) => {
    if (classify(msg) === "acp") send(ws, msg);
  });

  await Promise.race([closed, reading]);
  if (idleFlush) clearTimeout(idleFlush);
  requestFlush(0);
  executor.cancelAll();
  try {
    ws.close();
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
