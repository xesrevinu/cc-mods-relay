import { expect, test } from "bun:test";
import { addUsage, contextTokensUsed, EMPTY_USAGE, toUsageUpdate } from "../src/usage.js";
import { zSessionNotification } from "../node_modules/@agentclientprotocol/sdk/dist/v1/unstable/schema/zod.gen.js";

test("usage_update used is context occupancy, size is the window", () => {
  const update = toUsageUpdate(
    {
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 50,
      },
      total_cost_usd: 0.0123,
    },
    { contextWindowSize: 1_000_000 },
  );
  expect(update).toEqual({
    sessionUpdate: "usage_update",
    used: 970,
    size: 1_000_000,
    cost: { amount: 0.0123, currency: "USD" },
  });
  zSessionNotification.parse({ sessionId: "s", update });
});

test("context occupancy sums the four token fields without double-counting", () => {
  expect(
    contextTokensUsed({
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 3,
    }),
  ).toBe(20);
  expect(contextTokensUsed({})).toBeUndefined();
});

test("addUsage accumulates session totals", () => {
  const next = addUsage(EMPTY_USAGE, { input_tokens: 4, output_tokens: 1 });
  expect(addUsage(next, { input_tokens: 6, output_tokens: 2, cache_read_input_tokens: 8 })).toEqual({
    inputTokens: 10,
    outputTokens: 3,
    cachedReadTokens: 8,
    cachedWriteTokens: 0,
  });
});
