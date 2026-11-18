import { bashTool, cancelCall as cancelBash, sessionCwd } from "./tools/bash.js";
import { sendFileTool } from "./tools/deferred.js";
import { editTool } from "./tools/edit.js";
import { globTool } from "./tools/glob.js";
import { grepTool } from "./tools/grep.js";
import { hydrateTool } from "./tools/hydrate.js";
import { cancelAgent, cancelSession, wasCancelled } from "./tools/jobs.js";
import { monitorTool } from "./tools/monitor.js";
import { notebookEditTool } from "./tools/notebook.js";
import { mapPath, mergeRoots, PathDeniedError } from "./tools/paths.js";
import { readTool } from "./tools/read.js";
import { abortedShellResult, nativeToolResult, SHELL_TOOLS, type Send, type ToolFrame } from "./tools/runtime.js";
import { enterWorktreeTool, exitWorktreeTool } from "./tools/worktree.js";
import { writeTool } from "./tools/write.js";

export type { ToolFrame };

const fail = (send: Send, frame: ToolFrame, code: string, message: string) =>
  send({ v: 1, type: "result", id: frame.id, callId: frame.callId, sessionId: frame.sessionId, ok: false, error: { code, message } });

const ok = (send: Send, frame: ToolFrame, value: unknown) =>
  send({
    v: 1,
    type: "result",
    id: frame.id,
    callId: frame.callId,
    sessionId: frame.sessionId,
    ok: true,
    result: nativeToolResult(frame.tool, value, frame.input ?? {}),
  });

export { mapPath, cancelBash as cancelCall, cancelAgent, cancelSession };

export async function execute(frame: ToolFrame, send: Send, notify: Send = send): Promise<void> {
  const workspace = frame.cwd || process.cwd();
  const tuiRoot = frame.tuiRoot;
  const extraDirs = mergeRoots(Array.isArray(frame.extraDirs) ? frame.extraDirs.filter((d) => typeof d === "string") : []);
  const cwd = sessionCwd(frame, workspace);
  const input = frame.input ?? {};
  const stamped = { ...frame, cwd: workspace, extraDirs };
  const reply = (payload: Record<string, unknown>) => {
    try {
      send(payload);
    } catch {
      /* socket already gone; the tool still settled */
    }
  };
  const shell = SHELL_TOOLS.has(frame.tool ?? "");
  try {
    if (wasCancelled(frame.callId)) {
      if (shell) return ok(reply, frame, abortedShellResult());
      return fail(reply, frame, "CANCELLED", "Tool call was cancelled");
    }
    if (frame.tool === "Read") return ok(reply, frame, await readTool(cwd, tuiRoot, input, extraDirs, workspace));
    if (frame.tool === "Write") return ok(reply, frame, await writeTool(cwd, tuiRoot, input, extraDirs, workspace));
    if (frame.tool === "Edit") return ok(reply, frame, await editTool(cwd, tuiRoot, input, extraDirs, workspace));
    if (frame.tool === "Glob") return ok(reply, frame, await globTool(cwd, tuiRoot, input, extraDirs, workspace));
    if (frame.tool === "Grep") return ok(reply, frame, await grepTool(cwd, tuiRoot, input, extraDirs, frame.callId, frame.sessionId, workspace, frame.agentId));
    if (frame.tool === "NotebookEdit") return ok(reply, frame, await notebookEditTool(cwd, tuiRoot, input, extraDirs, workspace));
    if (frame.tool === "hydrate") return ok(reply, frame, await hydrateTool(cwd, tuiRoot, input, extraDirs, workspace));
    if (frame.tool === "Bash" || frame.tool === "PowerShell") return ok(reply, frame, await bashTool(workspace, stamped, input, notify));
    if (frame.tool === "Monitor") return ok(reply, frame, await monitorTool(workspace, stamped, input, notify));
    if (frame.tool === "EnterWorktree") return ok(reply, frame, await enterWorktreeTool(workspace, stamped, input, extraDirs));
    if (frame.tool === "ExitWorktree") return ok(reply, frame, await exitWorktreeTool(workspace, stamped, input));
    if (frame.tool === "SendFile" || frame.tool === "SendUserFile") {
      return ok(reply, frame, await sendFileTool(cwd, tuiRoot, input, extraDirs, workspace));
    }
    return fail(reply, frame, "UNSUPPORTED_TOOL", `${frame.tool || "unknown"} is not executed on this machine`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (wasCancelled(frame.callId) || /cancelled|aborted/i.test(message)) {
      if (shell) return ok(reply, frame, abortedShellResult());
      return fail(reply, frame, "CANCELLED", message);
    }
    if (error instanceof PathDeniedError) return fail(reply, frame, "PATH_DENIED", message);
    return fail(reply, frame, "TOOL_FAILED", message);
  }
}
