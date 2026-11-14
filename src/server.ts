import type { ServerWebSocket } from "bun";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { runAcp } from "./acp-agent.js";
import { bootAgent } from "./agent-main.js";
import { hostTuiRoot } from "./config.js";
import { debug } from "./debug.js";
import { isSafeAbsPath } from "./environment.js";
import { collectForwardedEnv } from "./forwarded-env.js";
import { stagePlugin, writeHomeFiles, writeSessionFiles, type SyncFile } from "./launch.js";
import { acpStreamFromWs, classify, parseWsJson } from "./mux.js";
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
  env?: unknown;
  files?: unknown;
  homeFiles?: unknown;
  callId?: string;
  id?: string;
  sessionId?: string;
  tool?: string;
  input?: unknown;
};

type Instance = {
  id: string;
  pluginToken: string;
  cwd: string;
  tuiRoot: string;
  extraDirs: string[];
  client: ServerWebSocket<SocketData>;
  pluginSockets: Set<ServerWebSocket<SocketData>>;
  pendingCalls: Map<string, ServerWebSocket<SocketData>>;
  mux?: ReturnType<typeof acpStreamFromWs>;
  dispose?: () => Promise<void>;
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
};

function rmTree(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function sendJson(ws: ServerWebSocket<SocketData>, msg: unknown) {
  if (ws.data?.alive === false) return;
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

  const sendClient = (inst: Instance, msg: unknown) => sendJson(inst.client, msg);

  const live = (inst: Instance) => instances.get(inst.id) === inst && !inst.closing;

  const teardown = (inst: Instance): Promise<void> => {
    if (inst.closing) return inst.closed ?? Promise.resolve();
    inst.closing = true;
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
    inst.pluginSockets.clear();
    inst.pendingCalls.clear();
    debug("instance teardown", { instanceId: inst.id });
    inst.closed = (async () => {
      try {
        await inst.dispose?.();
      } catch (error) {
        console.error(error);
      }
    })();
    lifetimes.add(inst.closed);
    return inst.closed;
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
    const requested =
      typeof frame.tuiRoot === "string" && isSafeAbsPath(frame.tuiRoot) && existsSync(frame.tuiRoot)
        ? frame.tuiRoot
        : undefined;
    const tuiRoot = requested ?? hostTuiRoot(cwd, { clientHome });
    if (tuiRoot !== cwd) {
      debug("TUI cwd is not the client cwd (mkdir of client path failed)", { cwd, tuiRoot });
    }
    writeSessionFiles(tuiRoot, filesOf(frame.files));
    writeHomeFiles(homedir(), filesOf(frame.homeFiles));
    const id = randomUUID();
    const pluginToken = randomUUID();
    const inst: Instance = {
      id,
      pluginToken,
      cwd,
      tuiRoot,
      extraDirs,
      client: ws,
      pluginSockets: new Set(),
      pendingCalls: new Map(),
    };
    instances.set(id, inst);
    byPluginToken.set(pluginToken, id);
    ws.data.instanceId = id;

    const mux = acpStreamFromWs((msg) => sendClient(inst, msg));
    inst.mux = mux;

    try {
      if (opts.pauseStart) await opts.pauseStart;
      if (!live(inst)) return;

      if (!boot) {
        sendJson(ws, { v: 1, type: "instance.ready", instanceId: id, cwd, tuiRoot });
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
      sendJson(ws, { v: 1, type: "instance.ready", instanceId: id, cwd, tuiRoot });
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
    const inst = ws.data.instanceId ? instances.get(ws.data.instanceId) : undefined;
    if (!inst) {
      sendJson(ws, { v: 1, type: "instance.error", error: { code: "NO_INSTANCE", message: "instance.start required" } });
      return;
    }
    if (frame.type === "result") {
      const callId = typeof frame.callId === "string" ? frame.callId : undefined;
      const plugin = callId ? inst.pendingCalls.get(callId) : undefined;
      if (plugin) {
        inst.pendingCalls.delete(callId!);
        sendJson(plugin, msg);
      }
      return;
    }
    if (frame.type === "notify") {
      for (const plugin of inst.pluginSockets) sendJson(plugin, msg);
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
      ws.data.calls.add(callId);
      inst.pendingCalls.set(callId, ws);
      sendClient(inst, {
        ...(msg as object),
        v: 1,
        type: "call",
        callId,
        cwd: frame.cwd || inst.cwd,
        tuiRoot: frame.tuiRoot || inst.tuiRoot,
        extraDirs: extraDirsOf(frame.extraDirs).length ? extraDirsOf(frame.extraDirs) : inst.extraDirs,
        sessionId: frame.sessionId || inst.id,
      });
      return;
    }
    if (frame.type === "cancel") {
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
      open() {},
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
      close(ws) {
        ws.data.alive = false;
        if (ws.data.role === "client" && ws.data.instanceId) {
          const inst = instances.get(ws.data.instanceId);
          if (inst && inst.client === ws) void teardown(inst);
          return;
        }
        if (ws.data.role === "plugin" && ws.data.instanceId) {
          const inst = instances.get(ws.data.instanceId);
          if (!inst) return;
          inst.pluginSockets.delete(ws);
          for (const callId of ws.data.calls) {
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
