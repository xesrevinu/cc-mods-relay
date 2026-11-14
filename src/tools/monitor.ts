import { asBool, asNumber, asString } from "./paths.js";
import { bashTool } from "./bash.js";
import { finishJob, registerJob, wasCancelled } from "./jobs.js";

type ToolFrame = {
  callId?: string;
  sessionId?: string;
  cwd?: string;
  tuiRoot?: string;
  extraDirs?: string[];
  tool?: string;
};

type Send = (frame: Record<string, unknown>) => void;

function assertWsUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Monitor ws.url is not a valid URL");
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("Monitor ws.url must be ws:// or wss://");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Monitor ws.url must not include credentials");
  }
  if (/\s/.test(url)) throw new Error("Monitor ws.url must not contain whitespace");
  return parsed.toString();
}

async function monitorWs(
  frame: ToolFrame,
  url: string,
  protocols: string[] | undefined,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const callId = frame.callId ?? "";
  if (wasCancelled(callId)) {
    return { output: "", interrupted: true };
  }
  const ws = protocols && protocols.length ? new WebSocket(url, protocols) : new WebSocket(url);
  const lines: string[] = [];
  let closed = "";
  let socket: WebSocket | undefined = ws;
  registerJob(callId, frame.sessionId || "", () => {
    try {
      socket?.close();
    } catch {
      /* already gone */
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        closed = `timed out after ${timeoutMs}ms`;
        try {
          ws.close();
        } catch {
          /* already gone */
        }
        resolve();
      }, timeoutMs);
      ws.addEventListener("message", (event) => {
        if (typeof event.data === "string") lines.push(event.data);
        else lines.push(`[binary frame, ${event.data instanceof ArrayBuffer ? event.data.byteLength : 0} bytes]`);
      });
      ws.addEventListener("close", (event) => {
        clearTimeout(timer);
        closed = `socket close ${event.code}`;
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`Monitor WebSocket error: ${url}`));
      });
    });
  } finally {
    socket = undefined;
    finishJob(callId);
    try {
      ws.close();
    } catch {
      /* already gone */
    }
  }
  const interrupted = wasCancelled(callId);
  const output = [...lines, closed].filter(Boolean).join("\n");
  return { output, interrupted };
}

export async function monitorTool(
  workspace: string,
  frame: ToolFrame,
  input: Record<string, unknown>,
  notify: Send,
): Promise<Record<string, unknown>> {
  const timeoutMs = Math.min(Math.max(asNumber(input.timeout_ms) ?? asNumber(input.timeout) ?? 120_000, 1), 600_000);
  const ws = input.ws;
  if (ws && typeof ws === "object") {
    const raw = ws as { url?: unknown; protocols?: unknown };
    const url = assertWsUrl(asString(raw.url));
    const protocols = Array.isArray(raw.protocols)
      ? raw.protocols.filter((p): p is string => typeof p === "string" && p.length > 0)
      : undefined;
    if (asString(input.command)) throw new Error("Monitor cannot combine command and ws");
    return monitorWs(frame, url, protocols, timeoutMs);
  }
  const command = asString(input.command);
  if (!command) throw new Error("Monitor requires command or ws");
  return bashTool(
    workspace,
    { ...frame, tool: "Bash" },
    { command, timeout: timeoutMs, run_in_background: asBool(input.persistent) === true },
    notify,
  );
}
