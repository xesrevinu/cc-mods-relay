import type {
  BashOutput,
  EnterWorktreeOutput,
  ExitWorktreeOutput,
  FileEditOutput,
  FileReadOutput,
  FileWriteOutput,
  GlobOutput,
  GrepOutput,
  MonitorOutput,
  NotebookEditOutput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";

export type ToolFrame = {
  id?: string;
  callId?: string;
  sessionId?: string;
  /** Claude Code session UUID (`$.session.id`); used for `tasks/<pid>.output`. */
  claudeSessionId?: string;
  /** Subagent that issued the call; `$.session.send` routes notify here. */
  agentId?: string;
  /** TUI host uid, so task files match `/tmp/claude-<uid>/...` on Mini. */
  tuiUid?: string | number;
  /** Mini timezone/locale snapshot; overlaid onto local Bash so `date`/`locale` match the TUI host. */
  tuiEnv?: Record<string, string>;
  cwd?: string;
  tuiRoot?: string;
  extraDirs?: string[];
  tool?: string;
  input?: Record<string, unknown>;
};

export type Send = (frame: Record<string, unknown>) => void;

export const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asObject(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function inputPath(input: Record<string, unknown>): string {
  for (const key of ["file_path", "path", "notebook_path"] as const) {
    const value = input[key];
    if (typeof value === "string") return value;
  }
  return "";
}

/**
 * Mods `tool.call` `{ result }` must match Claude Agent SDK ToolOutputSchemas.
 * A string is rejected (`expected object, received string`) and the builtin
 * runs on the TUI host.
 */
export function nativeToolResult(
  tool: string | undefined,
  result: unknown,
  input: Record<string, unknown> = {},
): Record<string, unknown> {
  if (result && typeof result === "object" && !Array.isArray(result)) return result as Record<string, unknown>;
  const text = asText(result);
  const filePath = inputPath(input);
  if (tool === "Read") {
    const lines = text.split("\n");
    return asObject({
      type: "text",
      file: { filePath, content: text, numLines: lines.length, startLine: 1, totalLines: lines.length },
    } satisfies FileReadOutput);
  }
  if (tool === "Write") {
    return asObject({
      type: "create",
      filePath,
      content: text,
      structuredPatch: [],
      originalFile: null,
    } satisfies FileWriteOutput);
  }
  if (tool === "Edit") {
    return asObject({
      filePath,
      oldString: "",
      newString: text,
      originalFile: null,
      structuredPatch: [],
      userModified: false,
      replaceAll: false,
    } satisfies FileEditOutput);
  }
  if (tool === "Bash" || tool === "PowerShell") {
    return asObject({ stdout: text, stderr: "", interrupted: false } satisfies BashOutput);
  }
  if (tool === "Grep") {
    return asObject({ numFiles: 0, filenames: [] } satisfies GrepOutput);
  }
  if (tool === "Glob") {
    return asObject({ durationMs: 0, numFiles: 0, filenames: [], truncated: false } satisfies GlobOutput);
  }
  if (tool === "NotebookEdit") {
    return asObject({
      new_source: text,
      cell_type: "code",
      language: "python",
      edit_mode: "replace",
      notebook_path: filePath,
      original_file: "",
      updated_file: "",
    } satisfies NotebookEditOutput);
  }
  if (tool === "Monitor") {
    return asObject({ taskId: "", timeoutMs: 0 } satisfies MonitorOutput);
  }
  if (tool === "EnterWorktree") {
    return asObject({ worktreePath: "", message: text } satisfies EnterWorktreeOutput);
  }
  if (tool === "ExitWorktree") {
    return asObject({
      action: "keep",
      originalCwd: "",
      worktreePath: "",
      message: text,
    } satisfies ExitWorktreeOutput);
  }
  if (tool === "SendFile" || tool === "SendUserFile") {
    return { filePath, bytes: 0 };
  }
  return asObject({ stdout: text, stderr: "", interrupted: false } satisfies BashOutput);
}

/**
 * Mods `{ result }` still has to be a ToolOutputSchema object. Native failures
 * that are not in that object live on `tool_result.is_error` (plugin `finish(true)`).
 *
 * In-schema channels: Bash.stderr, NotebookEdit.error, worktree.message, Grep.content.
 * FileRead/FileEdit/FileWrite have no error arm — the is_error string occupies the
 * primary text field so the model still sees it.
 */
export function nativeToolError(
  tool: string | undefined,
  message: unknown,
  input: Record<string, unknown> = {},
): Record<string, unknown> {
  const text = asText(message) || "Tool failed";
  const filePath = inputPath(input);
  if (tool === "Bash" || tool === "PowerShell") {
    return asObject({ stdout: "", stderr: text, interrupted: false } satisfies BashOutput);
  }
  if (tool === "NotebookEdit") {
    const editMode = typeof input.edit_mode === "string" && input.edit_mode ? input.edit_mode : "replace";
    return asObject({
      new_source: "",
      cell_type: "code",
      language: "python",
      edit_mode: editMode,
      error: text,
      notebook_path: filePath,
      original_file: "",
      updated_file: "",
    } satisfies NotebookEditOutput);
  }
  if (tool === "Grep") {
    return asObject({ numFiles: 0, filenames: [], content: text } satisfies GrepOutput);
  }
  if (tool === "Glob") {
    return asObject({ durationMs: 0, numFiles: 0, filenames: [], truncated: false } satisfies GlobOutput);
  }
  if (tool === "Read") {
    const lines = text.split("\n");
    return asObject({
      type: "text",
      file: { filePath, content: text, numLines: lines.length, startLine: 1, totalLines: lines.length },
    } satisfies FileReadOutput);
  }
  if (tool === "Write") {
    return asObject({
      type: "update",
      filePath,
      content: text,
      structuredPatch: [],
      originalFile: null,
    } satisfies FileWriteOutput);
  }
  if (tool === "Edit") {
    return asObject({
      filePath,
      oldString: "",
      newString: text,
      originalFile: null,
      structuredPatch: [],
      userModified: false,
      replaceAll: input.replace_all === true,
    } satisfies FileEditOutput);
  }
  if (tool === "EnterWorktree") {
    return asObject({ worktreePath: "", message: text } satisfies EnterWorktreeOutput);
  }
  if (tool === "ExitWorktree") {
    const action = input.action === "remove" ? "remove" as const : "keep" as const;
    return asObject({
      action,
      originalCwd: "",
      worktreePath: "",
      message: text,
    } satisfies ExitWorktreeOutput);
  }
  if (tool === "Monitor") {
    return asObject({ taskId: "", timeoutMs: 0 } satisfies MonitorOutput);
  }
  if (tool === "SendFile" || tool === "SendUserFile") {
    return { filePath, bytes: 0 };
  }
  return asObject({ stdout: "", stderr: text, interrupted: false } satisfies BashOutput);
}

export function abortedShellResult(stdout = "", stderr = ""): BashOutput {
  const extra = "Command was aborted before completion";
  const merged = stderr ? `${stderr.trimEnd()}\n${extra}` : extra;
  return { stdout, stderr: merged, interrupted: true };
}

export function clampTimeout(value: number | undefined, fallback: number, min: number, max: number): number {
  return Math.min(Math.max(value ?? fallback, min), max);
}

export function killTree(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export function ioMessage(path: string, error: unknown, missing: string): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return new Error(missing);
  if (code === "EACCES" || code === "EPERM") return new Error(`Permission denied: ${path}`);
  return error instanceof Error ? error : new Error(String(error));
}
