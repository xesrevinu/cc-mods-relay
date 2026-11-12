import { expect, test } from "bun:test";
import {
  clientSupportsCompaction,
  compactEventFromMessage,
  compactEventsFromMessages,
  compactPercentage,
  grokAutoCompactCompleted,
  grokAutoCompactStarted,
  grokCompactionSummary,
  isCompactBoundary,
  isCompactSummaryMessage,
} from "../src/compaction.js";

test("compact_boundary and isCompactSummary are the JSONL compaction markers", () => {
  const boundary = {
    type: "system",
    subtype: "compact_boundary",
    uuid: "b1",
    compactMetadata: { trigger: "auto", preTokens: 180_000, postTokens: 12_000 },
  };
  const summary = {
    type: "user",
    uuid: "s1",
    isCompactSummary: true,
    message: { role: "user", content: [{ type: "text", text: "Earlier we built the relay." }] },
  };
  expect(isCompactBoundary(boundary)).toBe(true);
  expect(isCompactSummaryMessage(summary)).toBe(true);
  expect(compactEventFromMessage(boundary)).toMatchObject({
    kind: "boundary",
    uuid: "b1",
    trigger: "auto",
    tokensBefore: 180_000,
    tokensAfter: 12_000,
  });
  expect(compactEventFromMessage(summary)).toEqual({
    kind: "summary",
    uuid: "s1",
    text: "Earlier we built the relay.",
  });
});

test("Grok compaction notifications match the x.ai session_update wire shape", () => {
  expect(grokAutoCompactStarted({
    sessionId: "sess",
    tokensUsed: 180_000,
    contextWindow: 200_000,
    percentage: 90,
  })).toEqual({
    method: "x.ai/session_notification",
    params: {
      sessionId: "sess",
      update: {
        sessionUpdate: "auto_compact_started",
        tokensUsed: 180_000,
        contextWindow: 200_000,
        percentage: 90,
        reason: "Context window 90% full",
      },
    },
  });
  expect(grokAutoCompactCompleted({
    sessionId: "sess",
    tokensBefore: 180_000,
    tokensAfter: 12_000,
    summaryPreview: "Earlier we",
  }).params.update).toMatchObject({
    sessionUpdate: "auto_compact_completed",
    tokensBefore: 180_000,
    tokensAfter: 12_000,
  });
  expect(grokCompactionSummary("sess", "Earlier we built the relay.")).toEqual({
    method: "pi/ui/compaction_summary",
    params: { sessionId: "sess", summary: "Earlier we built the relay." },
  });
});

test("client session.compaction {} is the ACP v1 advertisement", () => {
  expect(clientSupportsCompaction(undefined)).toBe(false);
  expect(clientSupportsCompaction({ session: { compaction: null } })).toBe(false);
  expect(clientSupportsCompaction({ session: { compaction: {} } })).toBe(true);
  expect(compactPercentage(90_000, 200_000)).toBe(45);
  expect(compactEventsFromMessages([
    { type: "user", uuid: "u1", message: { content: "hi" } },
    { type: "system", subtype: "compact_boundary", uuid: "b1" },
  ])).toHaveLength(1);
});
