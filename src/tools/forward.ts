/**
 * Which Claude Code builtins must run on the Mac (the project), which stay
 * native on Mini, and which ToolSearch loads on demand but still execute here.
 *
 * Do not forward everything. Agent, Skill, WebSearch, TodoWrite, AskUserQuestion,
 * PlanMode, MCP, Cron, Artifact (except file_path hydrate) are session/cloud/UI.
 * A subagent spawned on Mini still hits Read/Write through the workspace matcher.
 *
 * Default-exposed tools always intercept. Deferred tools stay off the default
 * list so ToolSearch can load them; once selected they run here, never deny.
 *
 * Code Mode's `REPL` tool runs the JavaScript sandbox on the TUI host. Do not
 * intercept it. Inner Bash/Read/Edit calls from that sandbox still match below.
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

/** ToolSearch extras. Execute locally when selected — do not hard-deny. */
export const DEFERRED_TOOLS = [
  "Monitor",
  "EnterWorktree",
  "ExitWorktree",
  "SendFile",
  "SendUserFile",
] as const;

export const LOCAL_TOOLS = [...WORKSPACE_TOOLS, ...DEFERRED_TOOLS] as const;

/** Cloud/UI tools that still need a copy of a Mac file on Mini before `next()`. */
export const HYDRATE_TOOLS = ["Artifact", "DesignSync"] as const;

export type WorkspaceTool = (typeof WORKSPACE_TOOLS)[number];
export type DeferredTool = (typeof DEFERRED_TOOLS)[number];
export type LocalTool = (typeof LOCAL_TOOLS)[number];
export type HydrateTool = (typeof HYDRATE_TOOLS)[number];

export function isLocalTool(name: string | undefined): boolean {
  return Boolean(name && (LOCAL_TOOLS as readonly string[]).includes(name));
}
