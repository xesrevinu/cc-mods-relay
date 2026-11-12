import { expect, test } from "bun:test";
import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { formatResetAt, planUsageFromSdk } from "../src/plan-usage.js";

function report(
  rateLimits: NonNullable<SDKControlGetUsageResponse["rate_limits"]>,
  behaviors: SDKControlGetUsageResponse["behaviors"] = null,
): SDKControlGetUsageResponse {
  return {
    session: {
      total_cost_usd: 0,
      total_api_duration_ms: 0,
      total_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      model_usage: {},
    },
    subscription_type: "pro",
    rate_limits_available: true,
    rate_limits: rateLimits,
    behaviors,
  };
}

test("planUsageFromSdk maps the Claude TUI five-hour, week, and Fable meters", () => {
  const view = planUsageFromSdk(
    report(
      {
        five_hour: { utilization: 10, resets_at: "2026-01-15T16:30:00Z" },
        seven_day: { utilization: 40, resets_at: "2026-01-20T18:00:00Z" },
        model_scoped: [
          {
            display_name: "Fable",
            utilization: 5,
            resets_at: "2026-01-20T18:00:00Z",
          },
        ],
      },
      {
        day: {
          request_count: 12,
          session_count: 2,
          behaviors: [],
          agents: [],
          skills: [],
          plugins: [],
          mcp_servers: [
            { name: "docs", pct: 60 },
            { name: "search", pct: 20 },
          ],
          recommendations: [
            { key: "mcp_server", pct: 60, title: "Disable unused MCP servers" },
            {
              key: "long_context",
              pct: 25,
              title: "Start a new session for a new task",
              detail: "run /clear",
            },
          ],
        },
        week: {
          request_count: 12,
          session_count: 2,
          behaviors: [],
          agents: [],
          skills: [],
          plugins: [],
          mcp_servers: [],
        },
      },
    ),
  );
  expect(view?.windows.map((window) => window.label)).toEqual([
    "Current session",
    "Current week (all models)",
    "Current week (Fable)",
  ]);
  expect(view?.windows.every((window) => window.utilization >= 0 && window.utilization <= 100)).toBe(true);
  expect(view?.mcpServers?.map((server) => server.name)).toEqual(["docs", "search"]);
  expect(view?.contributors?.[0]?.title).toContain("MCP");
});

test("planUsageFromSdk is absent when plan limits do not apply", () => {
  expect(
    planUsageFromSdk({
      session: {
        total_cost_usd: 0,
        total_api_duration_ms: 0,
        total_duration_ms: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
        model_usage: {},
      },
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null,
      behaviors: null,
    }),
  ).toBeUndefined();
});

test("formatResetAt matches Claude TUI same-day vs later-day copy", () => {
  const now = new Date("2026-01-15T12:00:00Z");
  const utc = { now, timeZone: "UTC" };
  expect(formatResetAt("2026-01-15T16:30:00Z", utc)).toMatch(/^Resets \d{1,2}:\d{2}[ap]m \(UTC\)$/);
  expect(formatResetAt("2026-01-20T18:00:00Z", utc)).toMatch(/^Resets \w+ \d{1,2} at \d{1,2}(?:am|pm) \(UTC\)$/);
});
