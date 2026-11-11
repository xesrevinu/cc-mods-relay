import type { SessionUpdate } from "@agentclientprotocol/sdk/unstable";

export type UsageUpdateNotification = Extract<SessionUpdate, { sessionUpdate: "usage_update" }>;

export interface UsageCarrier {
  usage?: { input_tokens?: number | null; output_tokens?: number | null } | null;
  model?: string | null;
}

export interface UsageOptions {
  contextWindowSize?: number;
}

function tokensUsed(message: UsageCarrier): number | undefined {
  const input = message?.usage?.input_tokens;
  const output = message?.usage?.output_tokens;
  if ((input === undefined || input === null) && (output === undefined || output === null)) {
    return undefined;
  }
  return (input ?? 0) + (output ?? 0);
}

export function toUsageUpdate(
  message: UsageCarrier,
  options: UsageOptions = {},
): UsageUpdateNotification | undefined {
  const used = tokensUsed(message);
  if (used === undefined) return undefined;
  const size = options.contextWindowSize ?? used;
  return { sessionUpdate: "usage_update", size, used };
}

export interface UsageFlagOptions extends UsageOptions {
  usageUpdate?: boolean;
}

export function usageUpdatesFor(
  message: UsageCarrier,
  options: UsageFlagOptions = {},
): UsageUpdateNotification[] {
  if (!options.usageUpdate) return [];
  const update = toUsageUpdate(message, options);
  return update ? [update] : [];
}

export type UsageModelKey = string | null;

function modelKeyOf(model: unknown): UsageModelKey {
  return typeof model === "string" && model.length > 0 ? model : null;
}

export function usageByModel(messages: Iterable<UsageCarrier>): Map<UsageModelKey, number> {
  const totals = new Map<UsageModelKey, number>();
  for (const message of messages) {
    const used = tokensUsed(message);
    if (used === undefined) continue;
    const key = modelKeyOf(message?.model);
    totals.set(key, (totals.get(key) ?? 0) + used);
  }
  return totals;
}
