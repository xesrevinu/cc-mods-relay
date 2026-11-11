import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { appendFileSync } from "node:fs";
import { LOOPBACK_HOST } from "../gate/port.js";
import { FORK_HOOK_MARKER_PATH } from "../gate/settings-writer.js";
import { allowDecision, denyDecision, type HookResponse } from "./deny.js";

export interface PreToolUsePayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  agent_id?: string;
  agent_type?: string;
}

export interface ForwardedToolCall {
  toolName: string;
  toolInput: unknown;
  toolUseId: string;
  sessionId?: string;
  permissionMode?: string;
  agentId?: string;
  agentType?: string;
}

export interface DenyWithReason {
  decision: "deny";
  reason: string;
}

export type ToolDecision = "allow" | "deny" | DenyWithReason;

export type ToolCallDecider = (call: ForwardedToolCall) => Promise<ToolDecision> | ToolDecision;

export interface HookServer {
  port: number;
  onToolCall(decider: ToolCallDecider): void;
  close(): Promise<void>;
}

export interface StartHookServerOptions {
  port: number;
  onToolCall?: ToolCallDecider;
  deciderTimeoutMs?: number;
  createHttpServer?: () => Server;
  onWarn?: (message: string) => void;
  token?: string;
}

export const DEFAULT_DECIDER_TIMEOUT_MS = 600_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function writeDecision(res: ServerResponse, decision: HookResponse): void {
  const json = JSON.stringify(decision);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(json);
}

function toHookResponse(decision: ToolDecision, call: ForwardedToolCall): HookResponse {
  if (decision === "allow") return allowDecision(call);
  if (decision === "deny") return denyDecision(call);
  return denyDecision(call, decision.reason);
}

export function parsePayload(raw: string): ForwardedToolCall | null {
  let parsed: PreToolUsePayload;
  try {
    parsed = JSON.parse(raw) as PreToolUsePayload;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const toolUseId = parsed.tool_use_id;
  const toolName = parsed.tool_name;
  if (typeof toolUseId !== "string" || toolUseId.length === 0) {
    return null;
  }
  if (typeof toolName !== "string" || toolName.length === 0) {
    return null;
  }
  return {
    toolName,
    toolInput: parsed.tool_input,
    toolUseId,
    sessionId: typeof parsed.session_id === "string" ? parsed.session_id : undefined,
    permissionMode: typeof parsed.permission_mode === "string" ? parsed.permission_mode : undefined,
    agentId: typeof parsed.agent_id === "string" ? parsed.agent_id : undefined,
    agentType: typeof parsed.agent_type === "string" ? parsed.agent_type : undefined,
  };
}

async function decideWithTimeout(
  decider: ToolCallDecider,
  call: ForwardedToolCall,
  timeoutMs: number,
  onWarn?: (message: string) => void,
): Promise<ToolDecision> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"deny">((resolve) => {
    timer = setTimeout(() => {
      onWarn?.(
        `[gate §9] FAIL CLOSED: decider timed out after ${timeoutMs}ms for tool_use ` +
          `${call.toolUseId} (tool "${call.toolName}") — denying.`,
      );
      resolve("deny");
    }, timeoutMs);
  });
  try {
    const decided = await Promise.race([Promise.resolve(decider(call)), timeout]);
    return decided;
  } catch (err) {
    onWarn?.(
      `[gate §9] FAIL CLOSED: decider threw for tool_use ${call.toolUseId} ` +
        `(${err instanceof Error ? err.message : String(err)}) — denying.`,
    );
    return "deny";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function startHookServer(opts: StartHookServerOptions): Promise<HookServer> {
  const {
    port,
    deciderTimeoutMs = DEFAULT_DECIDER_TIMEOUT_MS,
    createHttpServer = createServer,
    onWarn,
    token,
  } = opts;

  let decider: ToolCallDecider | undefined = opts.onToolCall;

  const server = createHttpServer();

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      let call: ForwardedToolCall | null = null;
      try {
        const raw = await readBody(req);
        if (process.env.FORK_HOOK_LOG_RAW) {
          try {
            appendFileSync(process.env.FORK_HOOK_LOG_RAW, raw + "\n");
          } catch {
          }
        }
        if (token !== undefined) {
          const urlPath = (req.url ?? "").split("?")[0];
          if (urlPath !== `${FORK_HOOK_MARKER_PATH}/${token}`) {
            onWarn?.(
              `[gate §9] FAIL CLOSED: PreToolUse POST presented a missing/incorrect per-session token ` +
                `(url path "${urlPath}") — denying WITHOUT invoking the decider.`,
            );
            writeDecision(
              res,
              denyDecision({ toolName: "(unauthorized)", toolUseId: "(unauthorized)" }),
            );
            return;
          }
        }
        call = parsePayload(raw);
        if (call === null) {
          onWarn?.(
            `[gate §9] FAIL CLOSED: unparseable or identity-less PreToolUse payload — denying.`,
          );
          writeDecision(res, denyDecision({ toolName: "(unknown)", toolUseId: "(unknown)" }));
          return;
        }
        if (decider === undefined) {
          onWarn?.(
            `[gate §9] FAIL CLOSED: no decider registered for tool_use ${call.toolUseId} — denying.`,
          );
          writeDecision(res, denyDecision(call));
          return;
        }
        const decision = await decideWithTimeout(decider, call, deciderTimeoutMs, onWarn);
        writeDecision(res, toHookResponse(decision, call));
      } catch (err) {
        onWarn?.(
          `[gate §9] FAIL CLOSED: hook request handler error ` +
            `(${err instanceof Error ? err.message : String(err)}) — denying.`,
        );
        try {
          writeDecision(
            res,
            denyDecision(call ?? { toolName: "(unknown)", toolUseId: "(unknown)" }),
          );
        } catch {
        }
      }
    })();
  });

  return new Promise<HookServer>((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve({
        port,
        onToolCall(next: ToolCallDecider): void {
          decider = next;
        },
        close(): Promise<void> {
          return new Promise((res) => {
            try {
              server.close(() => res());
            } catch {
              res();
            }
          });
        },
      });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, LOOPBACK_HOST);
  });
}
