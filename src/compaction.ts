import type { SessionMessage } from "./engine-watcher.js";

export type CompactionStatus = "in_progress" | "completed" | "failed" | "cancelled";

export type CompactBoundaryEvent = {
  kind: "boundary";
  uuid: string;
  trigger?: string;
  tokensBefore?: number;
  tokensAfter?: number;
};

export type CompactSummaryEvent = {
  kind: "summary";
  uuid: string;
  text: string;
};

export type CompactEvent = CompactBoundaryEvent | CompactSummaryEvent;

export function isCompactBoundary(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const rec = message as { type?: unknown; subtype?: unknown };
  return rec.type === "system" && rec.subtype === "compact_boundary";
}

export function isCompactSummaryMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  return (message as { isCompactSummary?: unknown }).isCompactSummary === true;
}

export function compactEventFromMessage(message: SessionMessage): CompactEvent | undefined {
  const uuid = typeof message.uuid === "string" ? message.uuid : undefined;
  if (!uuid) return undefined;
  if (isCompactBoundary(message)) {
    const meta = compactMetadataOf(message);
    return {
      kind: "boundary",
      uuid,
      trigger: meta.trigger,
      tokensBefore: meta.tokensBefore,
      tokensAfter: meta.tokensAfter,
    };
  }
  if (isCompactSummaryMessage(message)) {
    const text = compactSummaryText(message);
    if (!text) return undefined;
    return { kind: "summary", uuid, text };
  }
  return undefined;
}

export function compactEventsFromMessages(messages: SessionMessage[]): CompactEvent[] {
  const events: CompactEvent[] = [];
  for (const message of messages) {
    const event = compactEventFromMessage(message);
    if (event) events.push(event);
  }
  return events;
}

export function compactSummaryText(message: SessionMessage): string {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as { type?: unknown; text?: unknown };
    if (rec.type === "text" && typeof rec.text === "string" && rec.text.trim()) {
      parts.push(rec.text);
    }
  }
  return parts.join("").trim();
}

export function compactPercentage(used: number | undefined, window: number | undefined): number {
  if (used === undefined || !window || window <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((used / window) * 100)));
}

export function grokAutoCompactStarted(opts: {
  sessionId: string;
  tokensUsed: number;
  contextWindow: number;
  percentage: number;
  reason?: string;
}): { method: string; params: Record<string, unknown> } {
  const percentage = opts.percentage;
  return {
    method: "x.ai/session_notification",
    params: {
      sessionId: opts.sessionId,
      update: {
        sessionUpdate: "auto_compact_started",
        tokensUsed: opts.tokensUsed,
        contextWindow: opts.contextWindow,
        percentage,
        reason: opts.reason ?? `Context window ${percentage}% full`,
      },
    },
  };
}

export function grokAutoCompactCompleted(opts: {
  sessionId: string;
  tokensBefore?: number;
  tokensAfter: number;
  elapsedMs?: number;
  summaryPreview?: string;
}): { method: string; params: Record<string, unknown> } {
  return {
    method: "x.ai/session_notification",
    params: {
      sessionId: opts.sessionId,
      update: {
        sessionUpdate: "auto_compact_completed",
        ...(opts.tokensBefore !== undefined ? { tokensBefore: opts.tokensBefore } : {}),
        tokensAfter: opts.tokensAfter,
        ...(opts.elapsedMs !== undefined ? { elapsedMs: opts.elapsedMs } : {}),
        summaryPreview: opts.summaryPreview ?? null,
      },
    },
  };
}

export function grokAutoCompactCancelled(sessionId: string): {
  method: string;
  params: Record<string, unknown>;
} {
  return {
    method: "x.ai/session_notification",
    params: {
      sessionId,
      update: {
        sessionUpdate: "auto_compact_cancelled",
        reason: "user_cancelled",
      },
    },
  };
}

export function grokCompactionSummary(sessionId: string, summary: string): {
  method: string;
  params: Record<string, unknown>;
} {
  return {
    method: "pi/ui/compaction_summary",
    params: { sessionId, summary },
  };
}

export function clientSupportsCompaction(
  caps: { session?: { compaction?: unknown } | null } | undefined,
): boolean {
  const compaction = caps?.session?.compaction;
  return compaction !== undefined && compaction !== null;
}

function compactMetadataOf(message: SessionMessage): {
  trigger?: string;
  tokensBefore?: number;
  tokensAfter?: number;
} {
  const rec = message as {
    compactMetadata?: unknown;
    compact_metadata?: unknown;
  };
  const raw = rec.compactMetadata ?? rec.compact_metadata;
  if (!raw || typeof raw !== "object") return {};
  const meta = raw as Record<string, unknown>;
  const trigger = typeof meta.trigger === "string" ? meta.trigger : undefined;
  const tokensBefore = firstNumber(
    meta.preTokens,
    meta.pre_tokens,
    meta.tokensBefore,
    meta.preCompactTokens,
    meta.preCompactTokenCount,
  );
  const tokensAfter = firstNumber(
    meta.postTokens,
    meta.post_tokens,
    meta.tokensAfter,
    meta.promptTokens,
  );
  return { trigger, tokensBefore, tokensAfter };
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}
