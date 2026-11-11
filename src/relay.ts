import type { ServerWebSocket } from "bun";
import { createHash, randomUUID } from "node:crypto";
import { debug } from "./debug.js";
import { cancelCall, cancelSession, execute, type ToolFrame } from "./exec.js";

type SocketData = { alive: boolean; authed: boolean; calls: Set<string> };
export type TurnFrame = { type?: string; answer?: string; isAborted?: boolean; callId?: string; sessionId?: string; tool?: string; input?: unknown; ok?: boolean };

type Cached = { sig: string; payload: Record<string, unknown> };
const DEDUPE_MAX = 500;
const MUTATE = new Set(["Write", "Edit", "NotebookEdit", "hydrate"]);

function signature(frame: ToolFrame): string {
  return createHash("sha256").update(JSON.stringify({ tool: frame.tool, input: frame.input })).digest("hex");
}

export function startRelay() {
  const token = randomUUID();
  let cwd = process.cwd();
  let tuiRoot = cwd;
  let extraDirs: string[] = [];
  let sessionId = "";
  let ready: (() => void) | undefined;
  const opened = new Promise<void>((resolve) => { ready = resolve; });
  let onTurn: (frame: TurnFrame) => void = () => {};
  let onTool: (frame: TurnFrame) => void = () => {};
  const sockets = new Set<ServerWebSocket<SocketData>>();
  const dedupe = new Map<string, Cached>();
  const inflight = new Map<string, Promise<Record<string, unknown> | undefined>>();
  let mutateTail = Promise.resolve();

  const broadcast = (out: Record<string, unknown>) => {
    const data = JSON.stringify(out);
    for (const socket of sockets) {
      if (socket.data?.alive !== false && socket.data?.authed) socket.send(data);
    }
  };

  const runMutating = (work: () => Promise<void>) => {
    const run = mutateTail.then(work, work);
    mutateTail = run.then(() => undefined, () => undefined);
    return run;
  };

  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, bun) {
      const url = new URL(req.url);
      if (url.pathname !== "/tools") return new Response("not found", { status: 404 });
      if (req.headers.get("origin")) return new Response("forbidden", { status: 403 });
      if (bun.upgrade(req, { data: { alive: true, authed: false, calls: new Set() } })) return undefined;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      message(ws: ServerWebSocket<SocketData>, data: string | Buffer) {
        let frame: ToolFrame & TurnFrame & { token?: string; cwd?: string; tuiRoot?: string };
        try {
          frame = JSON.parse(typeof data === "string" ? data : data.toString());
        } catch {
          ws.send(JSON.stringify({ v: 1, type: "result", ok: false, error: { code: "INVALID_REQUEST", message: "Malformed JSON" } }));
          return;
        }
        if (frame.type === "hello") {
          if (frame.token !== token) {
            ws.close();
            return;
          }
          ws.data.authed = true;
          if (frame.cwd) cwd = frame.cwd;
          if (typeof frame.tuiRoot === "string" && frame.tuiRoot) tuiRoot = frame.tuiRoot;
          if (Array.isArray((frame as { extraDirs?: unknown }).extraDirs)) {
            extraDirs = ((frame as { extraDirs: unknown[] }).extraDirs).filter((d): d is string => typeof d === "string");
          }
          ws.send(JSON.stringify({ v: 1, type: "hello", ok: true }));
          debug("ws hello", { cwd, tuiRoot, extraDirs });
          ready?.();
          return;
        }
        if (!ws.data?.authed) {
          ws.send(JSON.stringify({ v: 1, type: "result", ok: false, error: { code: "UNAUTHORIZED", message: "hello required" } }));
          return;
        }
        const send = (out: Record<string, unknown>) => {
          if (ws.data?.alive !== false) ws.send(JSON.stringify(out));
        };
        if (frame.type === "call") {
          const stamped = {
            ...frame,
            cwd: frame.cwd || cwd,
            tuiRoot: frame.tuiRoot || tuiRoot,
            extraDirs: Array.isArray(frame.extraDirs) ? frame.extraDirs : extraDirs,
            sessionId: frame.sessionId || sessionId,
            callId: frame.callId || frame.id || randomUUID(),
          };
          const callId = stamped.callId;
          if (callId) {
            const sig = signature(stamped);
            const running = inflight.get(callId);
            if (running) {
              void running.then((payload) => {
                if (payload) send(payload);
              });
              return;
            }
            const hit = dedupe.get(callId);
            if (hit) {
              if (hit.sig !== sig) {
                send({ v: 1, type: "result", id: stamped.id, callId, sessionId: stamped.sessionId, ok: false, error: { code: "CALL_ID_CONFLICT", message: "callId reused with different input" } });
                return;
              }
              send(hit.payload);
              return;
            }
          }
          onTool(stamped);
          debug("ws call", { callId, tool: stamped.tool, input: stamped.input });
          ws.data.calls.add(callId);
          const work = async (): Promise<Record<string, unknown> | undefined> => {
            const captured: Record<string, unknown>[] = [];
            const capture: typeof send = (out) => {
              captured.push(out);
              send(out);
            };
            try {
              await execute(stamped, capture, broadcast);
            } catch (error) {
              const fail = {
                v: 1,
                type: "result",
                id: stamped.id,
                callId,
                sessionId: stamped.sessionId,
                ok: false,
                error: { code: "TOOL_FAILED", message: error instanceof Error ? error.message : String(error) },
              };
              captured.push(fail);
              send(fail);
            }
            const result = captured.find((out) => out.type === "result");
            debug("ws result", { callId, tool: stamped.tool, ok: result?.ok, error: result?.error, result: result?.result });
            if (callId && result) {
              if (dedupe.size >= DEDUPE_MAX) dedupe.delete(dedupe.keys().next().value!);
              dedupe.set(callId, { sig: signature(stamped), payload: result });
            }
            return result;
          };
          const pending = MUTATE.has(String(stamped.tool))
            ? new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
                void runMutating(async () => {
                  try {
                    resolve(await work());
                  } catch (error) {
                    reject(error);
                  }
                });
              })
            : work();
          inflight.set(callId, pending);
          void pending.finally(() => {
            inflight.delete(callId);
            ws.data.calls.delete(callId);
          });
          return;
        }
        if (frame.type === "cancel") {
          debug("ws cancel", { callId: frame.callId, sessionId: frame.sessionId || sessionId });
          if (frame.callId) cancelCall(frame.callId);
          else cancelSession(frame.sessionId || sessionId);
        }
        if (frame.type === "turn.complete" || frame.type === "turn.start") onTurn(frame);
      },
      close(ws) {
        if (ws.data) ws.data.alive = false;
        for (const id of ws.data?.calls ?? []) cancelCall(id);
        sockets.delete(ws);
      },
    },
  });

  return {
    token,
    bind(id: string, nextCwd: string, nextTuiRoot = nextCwd, nextExtra: string[] = []) {
      sessionId = id;
      cwd = nextCwd;
      tuiRoot = nextTuiRoot;
      extraDirs = nextExtra;
    },
    port: server.port ?? 0,
    url: `ws://127.0.0.1:${server.port}/tools`,
    waitUntilReady: (ms = 45_000) => Promise.race([
      opened,
      Bun.sleep(ms).then(() => Promise.reject(new Error("plugin hello did not reach the tool socket"))),
    ]),
    onTurn(handler: (frame: TurnFrame) => void) { onTurn = handler; },
    onTool(handler: (frame: TurnFrame) => void) { onTool = handler; },
    stop: () => {
      for (const ws of sockets) {
        for (const id of ws.data?.calls ?? []) cancelCall(id);
      }
      if (sessionId) cancelSession(sessionId);
      server.stop(true);
    },
  };
}
