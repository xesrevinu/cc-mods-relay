import { createHash, randomUUID } from "node:crypto";
import { debug } from "./debug.js";
import { cancelAgent, cancelCall, cancelSession, execute, type ToolFrame } from "./exec.js";
import { resetSessionCwd } from "./tools/bash.js";
import { rewriteRemotePath } from "./tools/paths.js";

export type TurnFrame = {
  type?: string;
  answer?: string;
  isAborted?: boolean;
  callId?: string;
  sessionId?: string;
  tool?: string;
  input?: unknown;
  ok?: boolean;
};

type Cached = { sig: string; payload: Record<string, unknown> };
const DEDUPE_MAX = 500;
const MUTATE = new Set(["Write", "Edit", "NotebookEdit", "hydrate", "EnterWorktree", "ExitWorktree"]);

function mutateKey(frame: ToolFrame, fallbackCwd: string, fallbackTuiRoot: string): string | undefined {
  const tool = String(frame.tool || "");
  if (!MUTATE.has(tool)) return undefined;
  if (tool === "EnterWorktree" || tool === "ExitWorktree") return "__worktree__";
  const input = frame.input ?? {};
  const raw =
    typeof input.file_path === "string" ? input.file_path
    : typeof input.notebook_path === "string" ? input.notebook_path
    : "";
  if (!raw) return "__mutate__";
  const proj = frame.cwd || fallbackCwd;
  const normalized = rewriteRemotePath(raw, proj, frame.tuiRoot || fallbackTuiRoot);
  return `file:${normalized}`;
}

function signature(frame: ToolFrame): string {
  return createHash("sha256").update(JSON.stringify({ tool: frame.tool, input: frame.input })).digest("hex");
}

export type ToolSend = (out: Record<string, unknown>) => void;

export function createToolExecutor() {
  let cwd = process.cwd();
  let tuiRoot = cwd;
  let extraDirs: string[] = [];
  let tuiEnv: Record<string, string> | undefined;
  let sessionId = "";
  let onTurn: (frame: TurnFrame) => void = () => {};
  let onTool: (frame: TurnFrame) => void = () => {};
  const dedupe = new Map<string, Cached>();
  const inflight = new Map<string, Promise<Record<string, unknown> | undefined>>();
  const calls = new Set<string>();
  const mutateTails = new Map<string, Promise<void>>();

  const runMutating = (key: string, work: () => Promise<void>) => {
    const prev = mutateTails.get(key) ?? Promise.resolve();
    const run = prev.then(work, work);
    const tail = run.then(
      () => {
        if (mutateTails.get(key) === tail) mutateTails.delete(key);
      },
      () => {
        if (mutateTails.get(key) === tail) mutateTails.delete(key);
      },
    );
    mutateTails.set(key, tail);
    return run;
  };

  return {
    bind(id: string, nextCwd: string, nextTuiRoot = nextCwd, nextExtra: string[] = []) {
      sessionId = id;
      cwd = nextCwd;
      tuiRoot = nextTuiRoot;
      extraDirs = nextExtra;
    },
    hello(frame: { cwd?: string; tuiRoot?: string; extraDirs?: unknown; tuiEnv?: unknown }) {
      if (frame.cwd) cwd = frame.cwd;
      if (typeof frame.tuiRoot === "string" && frame.tuiRoot) tuiRoot = frame.tuiRoot;
      if (Array.isArray(frame.extraDirs)) {
        extraDirs = frame.extraDirs.filter((d): d is string => typeof d === "string");
      }
      if (frame.tuiEnv && typeof frame.tuiEnv === "object" && !Array.isArray(frame.tuiEnv)) {
        tuiEnv = frame.tuiEnv as Record<string, string>;
      }
    },
    onTurn(handler: (frame: TurnFrame) => void) {
      onTurn = handler;
    },
    onTool(handler: (frame: TurnFrame) => void) {
      onTool = handler;
    },
    handle(
      frame: ToolFrame & TurnFrame & { extraDirs?: unknown },
      send: ToolSend,
      broadcast: ToolSend,
    ): string | undefined {
      if (frame.type === "call") {
        const stamped = {
          ...frame,
          cwd: frame.cwd || cwd,
          tuiRoot: frame.tuiRoot || tuiRoot,
          extraDirs: Array.isArray(frame.extraDirs) ? frame.extraDirs.filter((d): d is string => typeof d === "string") : extraDirs,
          tuiEnv: frame.tuiEnv ?? tuiEnv,
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
              send({
                v: 1,
                type: "result",
                id: stamped.id,
                callId,
                sessionId: stamped.sessionId,
                ok: false,
                error: { code: "CALL_ID_CONFLICT", message: "callId reused with different input" },
              });
              return;
            }
            send(hit.payload);
            return;
          }
        }
        onTool(stamped);
        debug("ws call", { callId, tool: stamped.tool, input: stamped.input });
        calls.add(callId);
        const work = async (): Promise<Record<string, unknown> | undefined> => {
          const captured: Record<string, unknown>[] = [];
          const capture: ToolSend = (out) => {
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
        const mKey = mutateKey(stamped, cwd, tuiRoot);
        const pending = mKey
          ? new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
              void runMutating(mKey, async () => {
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
          calls.delete(callId);
        });
        return callId;
      }
      if (frame.type === "cancel") {
        debug("ws cancel", { callId: frame.callId, sessionId: frame.sessionId || sessionId, agentId: frame.agentId });
        if (frame.callId) cancelCall(frame.callId);
        else if (frame.agentId) cancelAgent(frame.agentId);
        else cancelSession(frame.sessionId || sessionId);
        return;
      }
      if (frame.type === "turn.complete" || frame.type === "turn.start") onTurn(frame);
      return;
    },
    cancelAll() {
      for (const id of calls) cancelCall(id);
      if (sessionId) {
        cancelSession(sessionId);
        resetSessionCwd(sessionId);
      }
    },
  };
}

export type ToolExecutor = ReturnType<typeof createToolExecutor>;
