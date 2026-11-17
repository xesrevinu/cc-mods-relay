import { sessionCwd } from "./bash.js";
import { spawnEnv, withDirenv } from "./direnv.js";
import { finishJob, registerJob, wasCancelled } from "./jobs.js";
import { asNumber, asString, rewriteRemoteText } from "./paths.js";
import { abortedShellResult, clampTimeout, killTree, type Send, type ToolFrame } from "./runtime.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 1_800_000;

function timeoutSpec(input: Record<string, unknown>): { timeoutMs: number; persistent: boolean } {
  const raw = asNumber(input.timeout_ms) ?? asNumber(input.timeout);
  if (raw === 0) return { timeoutMs: 0, persistent: true };
  return { timeoutMs: clampTimeout(raw, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS), persistent: false };
}

function startedResult(id: string, timeoutMs: number, persistent: boolean): Record<string, unknown> {
  return { taskId: id, timeoutMs: persistent ? 0 : timeoutMs, ...(persistent ? { persistent: true } : {}) };
}

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

function notifyLine(notify: Send, frame: ToolFrame, line: string): void {
  if (!line) return;
  notify({
    v: 1,
    type: "notify",
    kind: "monitor",
    status: "event",
    callId: frame.callId,
    sessionId: frame.sessionId,
    line,
  });
}

function notifyEnd(
  notify: Send,
  frame: ToolFrame,
  status: "exited" | "expired",
  extra: Record<string, unknown> = {},
): void {
  notify({
    v: 1,
    type: "notify",
    kind: "monitor",
    status,
    callId: frame.callId,
    sessionId: frame.sessionId,
    ...extra,
  });
}

function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split(/\r?\n/);
  return { lines: parts.slice(0, -1), rest: parts.at(-1) ?? "" };
}

async function readLines(stream: ReadableStream<Uint8Array> | undefined, onLine: (line: string) => void): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let rest = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += decoder.decode(value, { stream: true });
    const split = splitLines(rest);
    rest = split.rest;
    for (const line of split.lines) onLine(line);
  }
  rest += decoder.decode();
  if (rest) onLine(rest);
}

function armTimeout(ms: number, onFire: () => void): () => void {
  const timer = setTimeout(onFire, ms);
  return () => clearTimeout(timer);
}

function startWsMonitor(
  frame: ToolFrame,
  url: string,
  protocols: string[] | undefined,
  ms: number,
  persistent: boolean,
  notify: Send,
): Record<string, unknown> {
  const callId = frame.callId ?? "";
  const ws = protocols && protocols.length ? new WebSocket(url, protocols) : new WebSocket(url);
  let socket: WebSocket | undefined = ws;
  let events = 0;
  let ended = false;
  let timedOut = false;
  const end = (status: "exited" | "expired", extra: Record<string, unknown>) => {
    if (ended) return;
    ended = true;
    stop();
    socket = undefined;
    const aborted = finishJob(callId);
    notifyEnd(notify, frame, aborted ? "exited" : status, { ...extra, interrupted: aborted, events });
  };
  const stop = persistent
    ? () => {}
    : armTimeout(ms, () => {
        timedOut = true;
        try {
          socket?.close();
        } catch {
          /* already gone */
        }
      });
  registerJob(callId, frame.sessionId || "", () => {
    stop();
    try {
      socket?.close();
    } catch {
      /* already gone */
    }
  });
  ws.addEventListener("message", (event) => {
    events += 1;
    if (typeof event.data === "string") notifyLine(notify, frame, event.data);
    else notifyLine(notify, frame, `[binary frame, ${event.data instanceof ArrayBuffer ? event.data.byteLength : 0} bytes]`);
  });
  ws.addEventListener("close", (event) => {
    end(timedOut ? "expired" : "exited", {
      exitCode: event.code === 1000 ? 0 : event.code,
      timeoutMs: timedOut ? ms : undefined,
    });
  });
  ws.addEventListener("error", () => {
    end(timedOut ? "expired" : "exited", { exitCode: 1, timeoutMs: timedOut ? ms : undefined });
  });
  return startedResult("ws", ms, persistent);
}

async function startCommandMonitor(
  workspace: string,
  frame: ToolFrame,
  command: string,
  ms: number,
  persistent: boolean,
  notify: Send,
): Promise<Record<string, unknown>> {
  const callId = frame.callId ?? "";
  const cwd = sessionCwd(frame, workspace);
  const env = await withDirenv(cwd, process.env);
  if (wasCancelled(callId)) {
    return abortedShellResult();
  }
  const proc = Bun.spawn(["bash", "-c", command], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
    env: spawnEnv(env),
  });
  const id = String(proc.pid);
  let events = 0;
  let timedOut = false;
  const stop = persistent
    ? () => {}
    : armTimeout(ms, () => {
        timedOut = true;
        killTree(proc.pid);
      });
  registerJob(callId, frame.sessionId || "", () => {
    stop();
    killTree(proc.pid);
  });
  const onLine = (line: string) => {
    events += 1;
    notifyLine(notify, frame, line);
  };
  void (async () => {
    try {
      await Promise.all([
        readLines(proc.stdout, onLine),
        readLines(proc.stderr, () => {
          /* stdout is the event stream */
        }),
        proc.exited,
      ]);
    } finally {
      stop();
      const aborted = finishJob(callId);
      notifyEnd(notify, frame, aborted ? "exited" : timedOut ? "expired" : "exited", {
        exitCode: aborted ? 137 : proc.exitCode ?? 1,
        events,
        interrupted: aborted,
        timeoutMs: timedOut ? ms : undefined,
      });
    }
  })();
  proc.unref();
  return startedResult(id, ms, persistent);
}

export async function monitorTool(
  workspace: string,
  frame: ToolFrame,
  input: Record<string, unknown>,
  notify: Send,
): Promise<Record<string, unknown>> {
  const { timeoutMs: ms, persistent } = timeoutSpec(input);
  const ws = input.ws;
  const command = rewriteRemoteText(asString(input.command), workspace, frame.tuiRoot);
  if (ws && typeof ws === "object") {
    if (command) throw new Error("exactly one of command or ws");
    const raw = ws as { url?: unknown; protocols?: unknown };
    const url = assertWsUrl(asString(raw.url));
    const protocols = Array.isArray(raw.protocols)
      ? raw.protocols.filter((p): p is string => typeof p === "string" && p.length > 0)
      : undefined;
    return startWsMonitor(frame, url, protocols, ms, persistent, notify);
  }
  if (!command) throw new Error("exactly one of command or ws");
  return startCommandMonitor(workspace, frame, command, ms, persistent, notify);
}
