import type { SessionUpdate } from "@agentclientprotocol/sdk/unstable";

export type UsageUpdateNotification = Extract<SessionUpdate, { sessionUpdate: "usage_update" }>;

export interface UsageCounts {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export interface UsageCarrier {
  usage?: UsageCounts | null;
  total_cost_usd?: number | null;
  model?: string | null;
}

export interface AccumulatedUsage {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
}

export const EMPTY_USAGE: AccumulatedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedReadTokens: 0,
  cachedWriteTokens: 0,
};

export interface UsageOptions {
  contextWindowSize?: number;
}

function count(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function hasUsage(usage: UsageCounts | null | undefined): boolean {
  if (!usage) return false;
  return (
    usage.input_tokens != null ||
    usage.output_tokens != null ||
    usage.cache_read_input_tokens != null ||
    usage.cache_creation_input_tokens != null
  );
}

/** Post-turn context occupancy: input excludes cache, so the four fields do not overlap. */
export function contextTokensUsed(usage: UsageCounts | null | undefined): number | undefined {
  if (!hasUsage(usage)) return undefined;
  return (
    count(usage?.input_tokens) +
    count(usage?.output_tokens) +
    count(usage?.cache_read_input_tokens) +
    count(usage?.cache_creation_input_tokens)
  );
}

export function toUsageUpdate(
  message: UsageCarrier,
  options: UsageOptions = {},
): UsageUpdateNotification | undefined {
  const used = contextTokensUsed(message.usage);
  if (used === undefined) return undefined;
  const size = options.contextWindowSize && options.contextWindowSize > 0 ? options.contextWindowSize : used;
  const amount = message.total_cost_usd;
  return {
    sessionUpdate: "usage_update",
    size,
    used,
    ...(typeof amount === "number" && Number.isFinite(amount)
      ? { cost: { amount, currency: "USD" as const } }
      : {}),
  };
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

export function addUsage(base: AccumulatedUsage, usage: UsageCounts | null | undefined): AccumulatedUsage {
  if (!hasUsage(usage)) return base;
  return {
    inputTokens: base.inputTokens + count(usage?.input_tokens),
    outputTokens: base.outputTokens + count(usage?.output_tokens),
    cachedReadTokens: base.cachedReadTokens + count(usage?.cache_read_input_tokens),
    cachedWriteTokens: base.cachedWriteTokens + count(usage?.cache_creation_input_tokens),
  };
}

export type UsageModelKey = string | null;

function modelKeyOf(model: unknown): UsageModelKey {
  return typeof model === "string" && model.length > 0 ? model : null;
}

export function usageByModel(messages: Iterable<UsageCarrier>): Map<UsageModelKey, number> {
  const totals = new Map<UsageModelKey, number>();
  for (const message of messages) {
    const used = contextTokensUsed(message.usage);
    if (used === undefined) continue;
    const key = modelKeyOf(message?.model);
    totals.set(key, (totals.get(key) ?? 0) + used);
  }
  return totals;
}
