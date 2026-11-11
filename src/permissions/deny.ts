export type PermissionDecision = "allow" | "deny";

export const HOOK_DENY_EXIT_CODE = 2;

export interface HookSpecificOutput {
  hookEventName: "PreToolUse";
  permissionDecision: PermissionDecision;
  permissionDecisionReason: string;
}

export interface HookResponse {
  hookSpecificOutput: HookSpecificOutput;
}

export interface DenyToolCall {
  toolName: string;
  toolUseId: string;
}

export function defaultDenyReason(toolCall: DenyToolCall): string {
  return (
    `Denied by the Zed permission gate (tool "${toolCall.toolName}", tool_use ${toolCall.toolUseId}). ` +
    `The tool was intercepted before it ran.`
  );
}

export function denyDecision(toolCall: DenyToolCall, reason?: string): HookResponse {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason ?? defaultDenyReason(toolCall),
    },
  };
}

export function allowDecision(toolCall: DenyToolCall, reason?: string): HookResponse {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason:
        reason ?? `Allowed by the Zed permission gate (tool "${toolCall.toolName}").`,
    },
  };
}

export const ASK_USER_QUESTION_TOOL = "AskUserQuestion";

export function isAskUserQuestionTool(toolName: string): boolean {
  return toolName === ASK_USER_QUESTION_TOOL;
}

export function askUserQuestionDenyReason(): string {
  return (
    `${ASK_USER_QUESTION_TOOL} is not supported over the Zed bridge: its interactive multiple-choice ` +
    `picker renders in a hidden PTY the user cannot see or answer, so the turn would stall. Denying it ` +
    `fail-closed — continue without asking an interactive question.`
  );
}

export function denyMatchesTool(matcher: string, toolName: string): boolean {
  return matcher === "*" || matcher === toolName;
}
