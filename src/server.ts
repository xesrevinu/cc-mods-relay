import type { ServerWebSocket } from "bun";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { runAcp } from "./acp-agent.js";
import { bootAgent } from "./agent-main.js";
import { hostTuiRoot } from "./config.js";
import { debug } from "./debug.js";
import { isSafeAbsPath } from "./environment.js";
import { applyGitStub, parseClientGit } from "./git-stub.js";
import { collectForwardedEnv } from "./forwarded-env.js";
import { stagePlugin, writeHomeFiles, writeSessionFiles, type SyncFile } from "./launch.js";
import { acpStreamFromWs, classify, parseWsJson } from "./mux.js";
import { claudeConfigDir } from "./jsonl.js";
import { parseTranscriptCursors } from "./transcript-mirror.js";
import { startTranscriptSync, type TranscriptSync } from "./transcript-sync.js";
import { reapOrphanPluginProcesses } from "./tui-reap.js";

export const SESSION_PATH = "/session";
export const TOOLS_PATH = "/tools";

type Role = "client" | "plugin";
type SocketData = {
  role: Role;
  alive: boolean;
  authed: boolean;
  instanceId?: string;
  listen?: boolean;
  calls: Set<string>;
};

type CtrlFrame = {
  v?: number;
  type?: string;
  token?: string;
  cwd?: string;
  home?: string;
  tuiRoot?: string;
  extraDirs?: unknown;
  tuiEnv?: unknown;
  reconnectGraceMs?: unknown;
  seqReplay?: unknown;
  lastSeq?: unknown;
  ack?: unknown;
  ts?: unknown;
  instanceId?: unknown;
  resumeToken?: unknown;
  env?: unknown;
  files?: unknown;
  homeFiles?: unknown;
  git?: unknown;
  transcriptCursors?: unknown;
  callId?: string;
  taskId?: string;
  scope?: string;
  id?: string;
  sessionId?: string;
  agentId?: string;
  tool?: string;
  input?: unknown;
};

type PendingCall = {
  ws: ServerWebSocket<SocketData>;
  sig: string;
  frame: Record<string, unknown>;
  orphanCancel?: ReturnType<typeof setTimeout>;
};

type ReplayEntry = {
  seq: number;
  envelope: Record<string, unknown>;
  bytes: number;
  callId?: string;
};

const REPLAY_LOG_MAX = 1024;
const REPLAY_LOG_MAX_BYTES = 8 * 1024 * 1024;

type Instance = {
  id: string;
  pluginToken: string;
  cwd: string;
  tuiRoot: string;
  extraDirs: string[];
  tuiEnv?: Record<string, string>;
  reconnectGraceMs?: number;
  resumeToken?: string;
  seqReplay?: boolean;
  nextSeq: number;
  replayLog: ReplayEntry[];
  replayLogBytes: number;
  graceTimer?: ReturnType<typeof setTimeout>;
  outboundBuffer?: unknown[];
  client: ServerWebSocket<SocketData>;
  pluginSockets: Set<ServerWebSocket<SocketData>>;
  pendingCalls: Map<string, PendingCall>;
  mux?: ReturnType<typeof acpStreamFromWs>;
  dispose?: () => Promise<void>;
  transcript?: TranscriptSync;
  closing?: boolean;
  closed?: Promise<void>;
};

export type ServeOpts = {
  token: string;
  hostname?: string;
  port?: number;
  /** Stage the Mods plugin and boot Claude. Tests may set false. */
  boot?: boolean;
  /** Tests: wait after the instance is registered, before boot/ready. */
  pauseStart?: Promise<void>;
  /** Tests: Claude config dir that holds project session JSONL. */
  claudeConfigDir?: string;
  idleMs?: number;
};

function rmTree(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function sendJson(ws: ServerWebSocket<SocketData>, msg: unknown) {
  if (ws.data?.alive === false || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* closed */
  }
}

function extraDirsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((d): d is string => typeof d === "string");
}

function envOf(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string" && raw) out[key] = raw;
  }
  return out;
}

function filesOf(value: unknown): SyncFile[] {
  if (!Array.isArray(value)) return [];
  const files: SyncFile[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const path = (row as { path?: unknown }).path;
    const content = (row as { content?: unknown }).content;
    if (typeof path === "string" && typeof content === "string") files.push({ path, content });
  }
  return files;
}

function isLoopbackAddr(addr?: string | null): boolean {
  return !addr || addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

async function healthBody(): Promise<Record<string, unknown>> {
  const version = async (bin: string) => {
    if (!Bun.which(bin)) return null;
    const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
    const text = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return text.split("\n")[0] || null;
  };
  return {
    ok: true,
    claude: await version("claude"),
    bun: Bun.version,
    herdr: await version("herdr"),
  };
}

export function startServer(opts: ServeOpts) {
  const token = opts.token;
  const boot = opts.boot !== false;
  const instances = new Map<string, Instance>();
  const byPluginToken = new Map<string, string>();
  const lifetimes = new Set<Promise<void>>();

  const trimReplayLog = (inst: Instance, ack: number) => {
    if (!Number.isFinite(ack) || ack <= 0 || inst.replayLog.length === 0) return;
    let drop = 0;
    while (drop < inst.replayLog.length && inst.replayLog[drop]!.seq <= ack) {
      inst.replayLogBytes -= inst.replayLog[drop]!.bytes;
      drop += 1;
    }
    if (drop > 0) inst.replayLog.splice(0, drop);
  };

  const recordReplay = (inst: Instance, envelope: Record<string, unknown>, seq: number, callId?: string) => {
    const bytes = JSON.stringify(envelope).length;
    if (bytes > REPLAY_LOG_MAX_BYTES / 2) return;
    while (
      inst.replayLog.length >= REPLAY_LOG_MAX ||
      (inst.replayLog.length > 0 && inst.replayLogBytes + bytes > REPLAY_LOG_MAX_BYTES)
    ) {
      const oldest = inst.replayLog.shift();
      if (oldest) inst.replayLogBytes -= oldest.bytes;
    }
    inst.replayLog.push({ seq, envelope, bytes, callId });
    inst.replayLogBytes += bytes;
  };

  const sendClient = (inst: Instance, msg: unknown) => {
    const kind = (msg as { type?: string } | null)?.type;
    if (inst.seqReplay && kind !== "transcript.append") {
      const seq = inst.nextSeq++;
      const envelope: Record<string, unknown> =
        classify(msg) === "acp"
          ? { v: 1, type: "acp", seq, msg }
          : { ...(msg as Record<string, unknown>), seq };
      const callId = kind === "call" && typeof (msg as { callId?: unknown }).callId === "string"
        ? (msg as { callId: string }).callId
        : undefined;
      recordReplay(inst, envelope, seq, callId);
      if (inst.client.data?.alive !== false && inst.client.readyState === 1) {
        sendJson(inst.client, envelope);
      }
      return;
    }
    if (inst.client.data?.alive !== false && inst.client.readyState === 1) {
      sendJson(inst.client, msg);
      return;
    }
    if (inst.graceTimer && !inst.closing) {
      if (kind === "transcript.append") return;
      const buf = (inst.outboundBuffer ??= []);
      if (buf.length >= 1024) {
        const dropIdx = buf.findIndex((item) => {
          const t = (item as { type?: string } | null)?.type;
          return t !== "call" && t !== "cancel";
        });
        buf.splice(dropIdx >= 0 ? dropIdx : 0, 1);
      }
      buf.push(msg);
    }
  };

  const live = (inst: Instance) => instances.get(inst.id) === inst && !inst.closing;

  const teardown = (inst: Instance): Promise<void> => {
    if (inst.closing) return inst.closed ?? Promise.resolve();
    inst.closing = true;
    if (inst.graceTimer) {
      clearTimeout(inst.graceTimer);
      inst.graceTimer = undefined;
    }
    inst.outboundBuffer = undefined;
    inst.replayLog.length = 0;
    inst.replayLogBytes = 0;
    instances.delete(inst.id);
    byPluginToken.delete(inst.pluginToken);
    if (inst.client.data.instanceId === inst.id) inst.client.data.instanceId = undefined;
    inst.mux?.close();
    for (const plugin of inst.pluginSockets) {
      try {
        plugin.close();
      } catch {
        /* already closed */
      }
    }
    for (const pending of inst.pendingCalls.values()) {
      if (pending.orphanCancel) clearTimeout(pending.orphanCancel);
    }
    inst.pluginSockets.clear();
    inst.pendingCalls.clear();
    try {
      inst.transcript?.flush();
      inst.transcript?.stop();
    } catch {
      /* best-effort */
    }
    debug("instance teardown", { instanceId: inst.id });
    const closed = (async () => {
      try {
        await inst.dispose?.();
      } catch (error) {
        console.error(error);
      }
    })();
    inst.closed = closed;
    lifetimes.add(closed);
    void closed.finally(() => lifetimes.delete(closed));
    return closed;
  };

  let server: ReturnType<typeof Bun.serve<SocketData>>;

  const startInstance = async (ws: ServerWebSocket<SocketData>, frame: CtrlFrame) => {
    const cwd = typeof frame.cwd === "string" && frame.cwd ? frame.cwd : "";
    if (!isSafeAbsPath(cwd)) {
      sendJson(ws, { v: 1, type: "instance.error", error: { code: "INVALID_CWD", message: "instance.start needs an absolute cwd" } });
      return;
    }
    const extraDirs = extraDirsOf(frame.extraDirs);
    const clientHome = typeof frame.home === "string" && isSafeAbsPath(frame.home) ? frame.home : undefined;
    const git = parseClientGit(frame.git);
    const requested =
      typeof frame.tuiRoot === "string" && isSafeAbsPath(frame.tuiRoot) && existsSync(frame.tuiRoot)
        ? frame.tuiRoot
        : undefined;
    const tuiRoot = requested ?? hostTuiRoot(cwd, { clientHome, git });
    applyGitStub(tuiRoot, git);
    if (tuiRoot !== cwd) {
      debug("TUI cwd is not the client cwd (mkdir of client path failed)", { cwd, tuiRoot });
    }
    if (Array.isArray(frame.files)) writeSessionFiles(tuiRoot, filesOf(frame.files));
    if (Array.isArray(frame.homeFiles)) writeHomeFiles(homedir(), filesOf(frame.homeFiles));
    const transcriptCursors = parseTranscriptCursors(frame.transcriptCursors);
    const id = randomUUID();
    const pluginToken = randomUUID();
    const rawGrace = typeof frame.reconnectGraceMs === "number" && Number.isFinite(frame.reconnectGraceMs)
      ? Math.max(0, Math.min(60_000, frame.reconnectGraceMs))
      : 0;
    const resumeToken = rawGrace > 0 ? randomUUID() : undefined;
    const seqReplay = frame.seqReplay === true;
    const inst: Instance = {
      id,
      pluginToken,
      cwd,
      tuiRoot,
      extraDirs,
      ...(rawGrace > 0 ? { reconnectGraceMs: rawGrace, resumeToken } : {}),
      ...(seqReplay ? { seqReplay: true } : {}),
      nextSeq: 1,
      replayLog: [],
      replayLogBytes: 0,
      client: ws,
      pluginSockets: new Set(),
      pendingCalls: new Map(),
    };
    instances.set(id, inst);
    byPluginToken.set(pluginToken, id);
    ws.data.instanceId = id;

    const mux = acpStreamFromWs((msg) => sendClient(inst, msg));
    inst.mux = mux;

    const attachTranscript = () => {
      if (!boot && !opts.claudeConfigDir) return;
      inst.transcript = startTranscriptSync({
        claudeConfigDir: opts.claudeConfigDir ?? claudeConfigDir(),
        cursors: transcriptCursors,
        send: (msg) => sendClient(inst, msg),
        canSend: () => inst.client.readyState === 1 && inst.client.getBufferedAmount() <= 1_024 * 1024,
        idleMs: opts.idleMs,
      });
    };

    try {
      if (opts.pauseStart) await opts.pauseStart;
      if (!live(inst)) return;

      if (!boot) {
        sendJson(ws, {
          v: 1,
          type: "instance.ready",
          instanceId: id,
          cwd,
          tuiRoot,
          ...(resumeToken ? { resumeToken } : {}),
        });
        attachTranscript();
        return;
      }

      const toolsUrl = `ws://127.0.0.1:${server.port}${TOOLS_PATH}`;
      const pluginDir = await stagePlugin({
        url: toolsUrl,
        token: pluginToken,
        cwd,
        tuiRoot,
      });
      if (!live(inst)) {
        rmTree(pluginDir);
        return;
      }
      const merged = { ...collectForwardedEnv(), ...envOf(frame.env) };
      const started = await bootAgent(pluginDir, { cwd, tuiRoot, env: { ...process.env, ...merged }, bindProcess: false });
      if (!live(inst)) {
        started.channel.stop();
        reapOrphanPluginProcesses(pluginDir);
        rmTree(pluginDir);
        return;
      }
      const { agent, connection } = runAcp(mux.stream, started.deps);
      inst.dispose = async () => {
        await agent.dispose().catch((error) => console.error(error));
        started.channel.stop();
        reapOrphanPluginProcesses(pluginDir);
        rmTree(pluginDir);
      };
      void connection.closed.then(() => {
        void teardown(inst);
      });
      if (!live(inst)) {
        await teardown(inst);
        return;
      }
      sendJson(ws, {
        v: 1,
        type: "instance.ready",
        instanceId: id,
        cwd,
        tuiRoot,
        ...(resumeToken ? { resumeToken } : {}),
      });
      attachTranscript();
    } catch (error) {
      await teardown(inst);
      throw error;
    }
  };

  const handleClient = (ws: ServerWebSocket<SocketData>, msg: unknown) => {
    const kind = classify(msg);
    if (kind === "acp") {
      const inst = ws.data.instanceId ? instances.get(ws.data.instanceId) : undefined;
      if (!inst?.mux) {
        sendJson(ws, { v: 1, type: "instance.error", error: { code: "NO_INSTANCE", message: "instance.start required" } });
        return;
      }
      inst.mux.pushAcp(msg);
      return;
    }
    const frame = (msg ?? {}) as CtrlFrame;
    if (frame.type === "hello") {
      if (frame.token !== token) {
        ws.close();
        return;
      }
      ws.data.authed = true;
      sendJson(ws, { v: 1, type: "hello", ok: true });
      return;
    }
    if (!ws.data.authed) {
      sendJson(ws, { v: 1, type: "instance.error", error: { code: "UNAUTHORIZED", message: "hello required" } });
      return;
    }
    if (frame.type === "instance.start") {
      if (ws.data.instanceId) {
        sendJson(ws, { v: 1, type: "instance.error", error: { code: "ALREADY_STARTED", message: "instance already started" } });
        return;
      }
      void startInstance(ws, frame).catch((error) => {
        sendJson(ws, {
          v: 1,
          type: "instance.error",
          error: { code: "BOOT_FAILED", message: error instanceof Error ? error.message : String(error) },
        });
      });
      return;
    }
    if (frame.type === "instance.attach") {
      const targetId = typeof frame.instanceId === "string" ? frame.instanceId : "";
      const inst = targetId ? instances.get(targetId) : undefined;
      if (!inst || inst.closing || !inst.resumeToken || frame.resumeToken !== inst.resumeToken) {
        sendJson(ws, { v: 1, type: "instance.error", error: { code: "ATTACH_REJECTED", message: "unknown or expired instance" } });
        return;
      }
      if (inst.graceTimer) {
        clearTimeout(inst.graceTimer);
        inst.graceTimer = undefined;
      }
      if (inst.client !== ws && inst.client.data.instanceId === inst.id) {
        inst.client.data.instanceId = undefined;
        try { inst.client.close(1000, "superseded"); } catch { /* ignore */ }
      }
      inst.client = ws;
      ws.data.instanceId = inst.id;
      sendJson(ws, {
        v: 1,
        type: "instance.ready",
        instanceId: inst.id,
        cwd: inst.cwd,
        tuiRoot: inst.tuiRoot,
        resumeToken: inst.resumeToken,
        reattached: true,
      });
      const queuedCalls = new Set<string>();
      if (inst.seqReplay) {
        const lastSeq = typeof frame.lastSeq === "number" && Number.isFinite(frame.lastSeq) ? Math.max(0, Math.floor(frame.lastSeq)) : 0;
        trimReplayLog(inst, lastSeq);
        for (const entry of inst.replayLog) {
          if (entry.seq <= lastSeq) continue;
          if (entry.callId) queuedCalls.add(entry.callId);
          sendJson(ws, entry.envelope);
        }
      } else {
        const queued = inst.outboundBuffer?.splice(0) ?? [];
        for (const item of queued) {
          const row = item as { type?: string; callId?: string } | null;
          if (row?.type === "call" && typeof row.callId === "string") queuedCalls.add(row.callId);
          sendJson(ws, item);
        }
      }
      // Replay still-pending tool calls whose request or result may have been lost
      // during a half-open TCP drop. Client tool-executor dedupes by callId.
      for (const [callId, entry] of inst.pendingCalls) {
        if (queuedCalls.has(callId)) continue;
        sendJson(ws, entry.frame);
      }
      inst.transcript?.flush();
      return;
    }
    const inst = ws.data.instanceId ? instances.get(ws.data.instanceId) : undefined;
    if (!inst) {
      sendJson(ws, { v: 1, type: "instance.error", error: { code: "NO_INSTANCE", message: "instance.start required" } });
      return;
    }
    if (frame.type === "ping") {
      if (typeof frame.ack === "number") trimReplayLog(inst, frame.ack);
      sendJson(ws, { v: 1, type: "pong", ...(typeof frame.ts === "number" ? { ts: frame.ts } : {}) });
      return;
    }
    if (frame.type === "result") {
      const callId = typeof frame.callId === "string" ? frame.callId : undefined;
      const pending = callId ? inst.pendingCalls.get(callId) : undefined;
      if (pending && callId) {
        if (pending.orphanCancel) clearTimeout(pending.orphanCancel);
        inst.pendingCalls.delete(callId);
        pending.ws.data.calls.delete(callId);
        sendJson(pending.ws, msg);
      }
      return;
    }
    if (frame.type === "notify") {
      const listeners = [...inst.pluginSockets].filter((p) => p.data.listen);
      const targets = listeners.length ? listeners : [...inst.pluginSockets];
      for (const plugin of targets) sendJson(plugin, msg);
      return;
    }
    if (frame.type === "transcript.flush") {
      const raw = frame.transcriptCursors;
      inst.transcript?.flush(raw === undefined ? undefined : parseTranscriptCursors(raw));
      return;
    }
  };

  const handlePlugin = (ws: ServerWebSocket<SocketData>, msg: unknown) => {
    const frame = (msg ?? {}) as CtrlFrame;
    if (frame.type === "hello") {
      const instanceId = typeof frame.token === "string" ? byPluginToken.get(frame.token) : undefined;
      const inst = instanceId ? instances.get(instanceId) : undefined;
      if (!inst) {
        ws.close();
        return;
      }
      ws.data.authed = true;
      ws.data.instanceId = inst.id;
      inst.pluginSockets.add(ws);
      if (frame.tuiEnv && typeof frame.tuiEnv === "object" && !Array.isArray(frame.tuiEnv)) {
        inst.tuiEnv = envOf(frame.tuiEnv);
      }
      sendJson(ws, { v: 1, type: "hello", ok: true });
      debug("plugin hello", { instanceId: inst.id });
      return;
    }
    if (!ws.data.authed) {
      sendJson(ws, { v: 1, type: "result", ok: false, error: { code: "UNAUTHORIZED", message: "hello required" } });
      return;
    }
    const inst = ws.data.instanceId ? instances.get(ws.data.instanceId) : undefined;
    if (!inst) {
      sendJson(ws, { v: 1, type: "result", ok: false, error: { code: "NO_INSTANCE", message: "instance gone" } });
      return;
    }
    if (frame.type === "listen") {
      ws.data.listen = true;
      return;
    }
    if (frame.type === "call") {
      const callId = typeof frame.callId === "string" ? frame.callId : typeof frame.id === "string" ? frame.id : randomUUID();
      const sig = JSON.stringify({ tool: frame.tool, input: frame.input });
      const prev = inst.pendingCalls.get(callId);
      if (prev && prev.sig !== sig) {
        sendJson(ws, {
          v: 1,
          type: "result",
          id: frame.id,
          callId,
          sessionId: frame.sessionId || inst.id,
          ok: false,
          error: { code: "CALL_ID_CONFLICT", message: "callId reused with different input" },
        });
        return;
      }
      if (prev) {
        if (prev.orphanCancel) clearTimeout(prev.orphanCancel);
        if (prev.ws !== ws) prev.ws.data.calls.delete(callId);
      }
      const outbound: Record<string, unknown> = {
        ...(msg as object),
        v: 1,
        type: "call",
        callId,
        cwd: frame.cwd || inst.cwd,
        tuiRoot: frame.tuiRoot || inst.tuiRoot,
        extraDirs: extraDirsOf(frame.extraDirs).length ? extraDirsOf(frame.extraDirs) : inst.extraDirs,
        ...(frame.tuiEnv === undefined && inst.tuiEnv ? { tuiEnv: inst.tuiEnv } : {}),
        sessionId: frame.sessionId || inst.id,
      };
      ws.data.calls.add(callId);
      inst.pendingCalls.set(callId, { ws, sig, frame: outbound });
      sendClient(inst, outbound);
      return;
    }
    if (frame.type === "aliasTask") {
      sendClient(inst, {
        v: 1,
        type: "aliasTask",
        callId: frame.callId,
        taskId: frame.taskId,
        sessionId: frame.sessionId || inst.id,
      });
      return;
    }
    if (frame.type === "cancel") {
      sendClient(inst, {
        ...(msg as object),
        v: 1,
        type: "cancel",
        callId: frame.callId,
        sessionId: frame.sessionId || inst.id,
        agentId: frame.agentId,
        ...(typeof frame.scope === "string" ? { scope: frame.scope } : {}),
      });
      return;
    }
    if (frame.type === "turn.start") {
      inst.transcript?.onTurnStart();
      sendClient(inst, msg);
      return;
    }
    if (frame.type === "turn.complete") {
      inst.transcript?.onTurnComplete();
      sendClient(inst, msg);
      return;
    }
  };

  server = Bun.serve<SocketData>({
    hostname: opts.hostname ?? "0.0.0.0",
    port: opts.port ?? 0,
    async fetch(req, bun) {
      const url = new URL(req.url);
      if (url.pathname === "/health" && req.method === "GET") {
        return Response.json(await healthBody());
      }
      if (req.headers.get("origin")) return new Response("forbidden", { status: 403 });
      if (url.pathname === SESSION_PATH) {
        if (bun.upgrade(req, { data: { role: "client", alive: true, authed: false, calls: new Set() } })) return undefined;
        return new Response("upgrade required", { status: 426 });
      }
      if (url.pathname === TOOLS_PATH) {
        const ip = bun.requestIP(req)?.address;
        if (!isLoopbackAddr(ip)) return new Response("forbidden", { status: 403 });
        if (bun.upgrade(req, { data: { role: "plugin", alive: true, authed: false, calls: new Set() } })) return undefined;
        return new Response("upgrade required", { status: 426 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      perMessageDeflate: true,
      idleTimeout: 120,
      sendPings: true,
      open() {},
      drain(ws) {
        if (ws.data.role === "client" && ws.data.instanceId) {
          const inst = instances.get(ws.data.instanceId);
          inst?.transcript?.flush();
        }
      },
      message(ws, data) {
        let msg: unknown;
        try {
          msg = parseWsJson(data as string | Buffer);
        } catch {
          sendJson(ws, { v: 1, type: "result", ok: false, error: { code: "INVALID_REQUEST", message: "Malformed JSON" } });
          return;
        }
        if (ws.data.role === "client") handleClient(ws, msg);
        else handlePlugin(ws, msg);
      },
      close(ws, code) {
        ws.data.alive = false;
        if (ws.data.role === "client" && ws.data.instanceId) {
          const inst = instances.get(ws.data.instanceId);
          if (inst && inst.client === ws) {
            if (code !== 1000 && inst.reconnectGraceMs && inst.reconnectGraceMs > 0 && !inst.closing) {
              if (inst.graceTimer) clearTimeout(inst.graceTimer);
              inst.graceTimer = setTimeout(() => {
                inst.graceTimer = undefined;
                void teardown(inst);
              }, inst.reconnectGraceMs);
              inst.graceTimer.unref?.();
            } else {
              void teardown(inst);
            }
          }
          return;
        }
        if (ws.data.role === "plugin" && ws.data.instanceId) {
          const inst = instances.get(ws.data.instanceId);
          if (!inst) return;
          inst.pluginSockets.delete(ws);
          // Only in-flight calls still owned by this socket: a result already
          // detached the id so background Bash/Monitor survive helper close, and
          // a newer socket retrying the same callId must not be cancelled.
          // If the persistent listener socket drops, give the plugin's one-shot
          // 502 fallback a brief grace window to rebind ownership before cancelling.
          for (const callId of ws.data.calls) {
            const pending = inst.pendingCalls.get(callId);
            if (!pending || pending.ws !== ws) continue;
            if (ws.data.listen) {
              if (pending.orphanCancel) clearTimeout(pending.orphanCancel);
              pending.orphanCancel = setTimeout(() => {
                const cur = inst.pendingCalls.get(callId);
                if (!cur || cur.ws !== ws) return;
                inst.pendingCalls.delete(callId);
                sendClient(inst, { v: 1, type: "cancel", callId, sessionId: inst.id });
              }, 5_000);
              pending.orphanCancel.unref?.();
              continue;
            }
            inst.pendingCalls.delete(callId);
            sendClient(inst, { v: 1, type: "cancel", callId, sessionId: inst.id });
          }
        }
      },
    },
  });

  const port = server.port ?? 0;
  const sessionUrl = `ws://127.0.0.1:${port}${SESSION_PATH}`;
  const toolsUrl = `ws://127.0.0.1:${port}${TOOLS_PATH}`;

  return {
    token,
    port,
    sessionUrl,
    toolsUrl,
    instances,
    stop: async () => {
      await Promise.all([...instances.values()].map((inst) => teardown(inst)));
      await Promise.all([...lifetimes]);
      server.stop(true);
    },
  };
}

export async function runServe(opts: { bind?: string; port?: number; token: string }) {
  const server = startServer({
    token: opts.token,
    hostname: opts.bind ?? "0.0.0.0",
    port: opts.port ?? 0,
  });
  console.error(`cc-mods-relay: listening on ws://${opts.bind ?? "0.0.0.0"}:${server.port}${SESSION_PATH}`);
  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  await new Promise(() => {});
}
