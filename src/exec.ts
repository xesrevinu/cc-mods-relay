import { bashTool, cancelCall as cancelBash } from "./tools/bash.js";
import { editTool } from "./tools/edit.js";
import { globTool } from "./tools/glob.js";
import { grepTool } from "./tools/grep.js";
import { hydrateTool } from "./tools/hydrate.js";
import { cancelSession, wasCancelled } from "./tools/jobs.js";
import { notebookEditTool } from "./tools/notebook.js";
import { mapPath } from "./tools/paths.js";
import { readTool } from "./tools/read.js";
import { writeTool } from "./tools/write.js";

export type ToolFrame = {
  id?: string;
  callId?: string;
  sessionId?: string;
  cwd?: string;
  tuiRoot?: string;
  extraDirs?: string[];
  tool?: string;
  input?: Record<string, unknown>;
};

type Send = (frame: Record<string, unknown>) => void;

const fail = (send: Send, frame: ToolFrame, code: string, message: string) =>
  send({ v: 1, type: "result", id: frame.id, callId: frame.callId, sessionId: frame.sessionId, ok: false, error: { code, message } });

const ok = (send: Send, frame: ToolFrame, value: unknown) =>
  send({ v: 1, type: "result", id: frame.id, callId: frame.callId, sessionId: frame.sessionId, ok: true, result: value });

export { mapPath, cancelBash as cancelCall, cancelSession };

export async function execute(frame: ToolFrame, send: Send, notify: Send = send): Promise<void> {
  const cwd = frame.cwd || process.cwd();
  const tuiRoot = frame.tuiRoot;
  const extraDirs = Array.isArray(frame.extraDirs) ? frame.extraDirs.filter((d) => typeof d === "string") : [];
  const input = frame.input ?? {};
  const reply = (payload: Record<string, unknown>) => {
    try {
      send(payload);
    } catch {
      /* socket already gone; the tool still settled */
    }
  };
  try {
    if (wasCancelled(frame.callId)) {
      if (frame.tool === "Bash" || frame.tool === "PowerShell") {
        return ok(reply, frame, { stdout: "", stderr: "Command was aborted before completion", interrupted: true });
      }
      return fail(reply, frame, "CANCELLED", "Tool call was cancelled");
    }
    if (frame.tool === "Read") return ok(reply, frame, await readTool(cwd, tuiRoot, input, extraDirs));
    if (frame.tool === "Write") return ok(reply, frame, await writeTool(cwd, tuiRoot, input, extraDirs));
    if (frame.tool === "Edit") return ok(reply, frame, await editTool(cwd, tuiRoot, input, extraDirs));
    if (frame.tool === "Glob") return ok(reply, frame, await globTool(cwd, tuiRoot, input, extraDirs));
    if (frame.tool === "Grep") return ok(reply, frame, await grepTool(cwd, tuiRoot, input, extraDirs, frame.callId, frame.sessionId));
    if (frame.tool === "NotebookEdit") return ok(reply, frame, await notebookEditTool(cwd, tuiRoot, input, extraDirs));
    if (frame.tool === "hydrate") return ok(reply, frame, await hydrateTool(cwd, tuiRoot, input, extraDirs));
    if (frame.tool === "Bash" || frame.tool === "PowerShell") return ok(reply, frame, await bashTool(cwd, frame, input, notify));
    return fail(reply, frame, "UNSUPPORTED_TOOL", `${frame.tool || "unknown"} is not executed on this machine`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (wasCancelled(frame.callId) || /cancelled|aborted/i.test(message)) {
      if (frame.tool === "Bash" || frame.tool === "PowerShell") {
        return ok(reply, frame, { stdout: "", stderr: "Command was aborted before completion", interrupted: true });
      }
      return fail(reply, frame, "CANCELLED", message);
    }
    return fail(reply, frame, "TOOL_FAILED", message);
  }
}
