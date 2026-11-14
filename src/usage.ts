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

function finiteUsd(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function costFromModelUsage(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  let sum = 0;
  let found = false;
  for (const row of Object.values(value as Record<string, unknown>)) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const cost = finiteUsd(rec.costUSD) ?? finiteUsd(rec.costUsd) ?? finiteUsd(rec.cost_usd);
    if (cost === undefined) continue;
    sum += cost;
    found = true;
  }
  return found ? sum : undefined;
}

/**
 * Session USD from a Claude JSONL / SDK usage record.
 * Prefer `modelUsage.costUSD` (the accounting object `/usage` uses) over a
 * zeroed `total_cost_usd` — subscription transcripts often leave the latter at 0.
 * Result records are cumulative; callers should keep the latest, not sum.
 */
export function sessionCostUsdFromRecord(record: unknown): number | undefined {
  if (!record || typeof record !== "object") return undefined;
  const rec = record as Record<string, unknown>;
  const fromModels = costFromModelUsage(rec.modelUsage) ?? costFromModelUsage(rec.model_usage);
  const total =
    finiteUsd(rec.total_cost_usd) ?? finiteUsd(rec.costUSD) ?? finiteUsd(rec.costUsd) ?? finiteUsd(rec.cost_usd);
  if (fromModels !== undefined && fromModels > 0) return fromModels;
  if (total !== undefined && total > 0) return total;
  if (fromModels !== undefined) return fromModels;
  if (total !== undefined) return total;
  if (rec.session) {
    const nested = sessionCostUsdFromRecord(rec.session);
    if (nested !== undefined) return nested;
  }
  if (rec.message) return sessionCostUsdFromRecord(rec.message);
  return undefined;
}

export function latestSessionCostUsd(messages: Iterable<unknown>): number | undefined {
  let last: number | undefined;
  for (const message of messages) {
    const cost = sessionCostUsdFromRecord(message);
    if (cost !== undefined) last = cost;
  }
  return last;
}

export function scanSessionCostFromJsonl(contents: string): number | undefined {
  const lines = contents.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const cost = sessionCostUsdFromRecord(JSON.parse(line));
      if (cost !== undefined) return cost;
    } catch {
      continue;
    }
  }
  return undefined;
}
