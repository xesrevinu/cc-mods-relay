/**
 * Which Claude Code builtins must run on the Mac (the project), which would
 * silently hit Mini's empty TUI cwd and must be denied, and which stay native.
 *
 * Do not forward everything. Agent, Skill, WebSearch, TodoWrite, AskUserQuestion,
 * PlanMode, MCP, Cron, Artifact (except file_path hydrate) are session/cloud/UI.
 * A subagent spawned on Mini still hits Read/Write through the workspace matcher.
 *
 * The host session cwd is a layout stub. Tools that touch the workspace run
 * here; tools that would touch the stub and have no local executor are denied.
 */
export const WORKSPACE_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "NotebookEdit",
  "Bash",
  "PowerShell",
] as const;

/** Local FS/process tools we do not execute, and must not run on Mini either. */
export const HOST_WRONG_TOOLS = [
  "LSP",
  "Monitor",
  "EnterWorktree",
  "ExitWorktree",
  "SendFile",
  "SendUserFile",
] as const;

/** Cloud/UI tools that still need a copy of a Mac file on Mini before `next()`. */
export const HYDRATE_TOOLS = ["Artifact", "DesignSync"] as const;

export type WorkspaceTool = (typeof WORKSPACE_TOOLS)[number];
export type HostWrongTool = (typeof HOST_WRONG_TOOLS)[number];
export type HydrateTool = (typeof HYDRATE_TOOLS)[number];
