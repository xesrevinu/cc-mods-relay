export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface ToolCallUpdateLike {
  toolCallId: string;
  title?: string;
  rawInput?: unknown;
}

export interface RequestPermissionParams {
  sessionId: string;
  toolCall: ToolCallUpdateLike;
  options: PermissionOption[];
}

export type RequestPermissionOutcome =
  { outcome: "cancelled" } | { outcome: "selected"; optionId: string };

export interface RequestPermissionResult {
  outcome: RequestPermissionOutcome;
}

export interface PermissionClient {
  requestPermission(params: RequestPermissionParams): Promise<RequestPermissionResult>;
}

export interface PermissionToolCall {
  toolUseId: string;
  toolName: string;
  toolInput?: unknown;
}

export const ALLOW_OPTION_ID = "allow";
export const DENY_OPTION_ID = "deny";

export function buildPermissionOptions(): PermissionOption[] {
  return [
    { optionId: ALLOW_OPTION_ID, name: "Allow", kind: "allow_once" },
    { optionId: DENY_OPTION_ID, name: "Deny", kind: "reject_once" },
  ];
}

export class ToolUseCorrelator {
  private readonly seen = new Map<string, number>();
  private readonly consumed = new Set<string>();

  register(toolUseId: string): boolean {
    const count = this.seen.get(toolUseId) ?? 0;
    this.seen.set(toolUseId, count + 1);
    return count === 0;
  }

  ensureRegistered(toolUseId: string): void {
    if ((this.seen.get(toolUseId) ?? 0) === 0) this.seen.set(toolUseId, 1);
  }

  isCleanMatch(toolUseId: string): boolean {
    return this.seen.get(toolUseId) === 1 && !this.consumed.has(toolUseId);
  }

  decide(toolUseId: string): "proceed" | "deny" {
    const count = this.seen.get(toolUseId) ?? 0;
    if (count !== 1 || this.consumed.has(toolUseId)) {
      return "deny";
    }
    this.consumed.add(toolUseId);
    return "proceed";
  }
}

export interface RequestPermissionOptions {
  client: PermissionClient;
  sessionId: string;
  toolCall: PermissionToolCall;
  correlator: ToolUseCorrelator;
  onWarn?: (message: string) => void;
  dialogToolCallId?: string;
  subagentLabel?: string;
}

export async function requestPermission(opts: RequestPermissionOptions): Promise<"allow" | "deny"> {
  const { client, sessionId, toolCall, correlator, onWarn, dialogToolCallId, subagentLabel } = opts;

  const correlation = correlator.decide(toolCall.toolUseId);
  if (correlation === "deny") {
    onWarn?.(
      `[gate §9] FAIL CLOSED: tool_use ${toolCall.toolUseId} (tool "${toolCall.toolName}") is not a ` +
        `clean single match in the JSONL correlation map (missing or duplicate) — denying rather than ` +
        `approving an uncorrelated call.`,
    );
    return "deny";
  }

  let result: RequestPermissionResult;
  try {
    result = await client.requestPermission({
      sessionId,
      toolCall: {
        toolCallId: dialogToolCallId ?? toolCall.toolUseId,
        title:
          subagentLabel !== undefined
            ? `${toolCall.toolName} · from the ${subagentLabel} agent`
            : toolCall.toolName,
        rawInput: toolCall.toolInput,
      },
      options: buildPermissionOptions(),
    });
  } catch (err) {
    onWarn?.(
      `[gate §9] FAIL CLOSED: session/request_permission transport error for tool_use ` +
        `${toolCall.toolUseId} (${err instanceof Error ? err.message : String(err)}) — denying.`,
    );
    return "deny";
  }

  const outcome = result.outcome;
  if (outcome.outcome === "selected" && outcome.optionId === ALLOW_OPTION_ID) {
    return "allow";
  }
  if (outcome.outcome === "selected" && outcome.optionId === DENY_OPTION_ID) {
    return "deny";
  }
  onWarn?.(
    `[gate §9] FAIL CLOSED: tool_use ${toolCall.toolUseId} resolved to ` +
      `${outcome.outcome === "selected" ? `unknown option "${outcome.optionId}"` : "cancelled"} — denying.`,
  );
  return "deny";
}
