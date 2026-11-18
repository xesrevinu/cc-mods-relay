import type { ServerWebSocket } from "bun";
import { randomUUID } from "node:crypto";
import { debug } from "./debug.js";
import { cancelCall, type ToolFrame } from "./exec.js";
import { createToolExecutor, type TurnFrame } from "./tool-executor.js";

export type { TurnFrame };

type SocketData = { alive: boolean; authed: boolean; calls: Set<string> };

export function startRelay() {
  const token = randomUUID();
  const executor = createToolExecutor();
  let ready: (() => void) | undefined;
  const opened = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const sockets = new Set<ServerWebSocket<SocketData>>();

  const broadcast = (out: Record<string, unknown>) => {
    const data = JSON.stringify(out);
    for (const socket of sockets) {
      if (socket.data?.alive !== false && socket.data?.authed) socket.send(data);
    }
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
      perMessageDeflate: true,
      idleTimeout: 120,
      sendPings: true,
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
          executor.hello(frame);
          ws.send(JSON.stringify({ v: 1, type: "hello", ok: true }));
          debug("ws hello", { cwd: frame.cwd });
          ready?.();
          return;
        }
        if (!ws.data?.authed) {
          ws.send(JSON.stringify({ v: 1, type: "result", ok: false, error: { code: "UNAUTHORIZED", message: "hello required" } }));
          return;
        }
        const send = (out: Record<string, unknown>) => {
          // The plugin helper closes this socket after the first result.
          // Background Bash/Monitor keep running and notify on the listen socket.
          if (out.type === "result" && typeof out.callId === "string") {
            ws.data.calls.delete(out.callId);
          }
          if (ws.data?.alive !== false) ws.send(JSON.stringify(out));
        };
        const callId = executor.handle(frame, send, broadcast);
        if (callId) ws.data.calls.add(callId);
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
      executor.bind(id, nextCwd, nextTuiRoot, nextExtra);
    },
    port: server.port ?? 0,
    url: `ws://127.0.0.1:${server.port}/tools`,
    waitUntilReady: (ms = 45_000) => Promise.race([
      opened,
      Bun.sleep(ms).then(() => Promise.reject(new Error("plugin hello did not reach the tool socket"))),
    ]),
    onTurn(handler: (frame: TurnFrame) => void) {
      executor.onTurn(handler);
    },
    onTool(handler: (frame: TurnFrame) => void) {
      executor.onTool(handler);
    },
    stop: () => {
      executor.cancelAll();
      server.stop(true);
    },
  };
}
