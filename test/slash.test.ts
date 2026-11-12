import { expect, test } from "bun:test";
import { BUILTIN_COMMANDS } from "../src/command-catalog.js";
import {
  dispatchSlash,
  formatCompactTokens,
  formatContext,
  formatDuration,
  formatUsage,
  isAdvertisedSlash,
  occupancyBar,
  occupancyPercent,
  parseSlashPrompt,
  type SlashSessionView,
} from "../src/slash.js";
import { EMPTY_USAGE } from "../src/usage.js";

const session: SlashSessionView = {
  cwd: "/tmp/app",
  model: "haiku",
  modelDisplayName: "Haiku 5.5",
  mode: "default",
  effort: "medium",
  fast: false,
  models: ["default", "sonnet", "opus", "haiku"],
  effortLevels: ["low", "medium", "high"],
  contextUsed: 12_300,
  contextSize: 1_000_000,
  usage: {
    ...EMPTY_USAGE,
    inputTokens: 1_200,
    outputTokens: 40,
    cachedReadTokens: 300,
    cachedWriteTokens: 20,
  },
  costUsd: 0.01,
  mcpServers: ["workspace"],
  additionalDirectories: ["/tmp/extra"],
  startedAtMs: 1_000,
  nowMs: 1_000 + 203_000,
};

test("every advertised slash is handled without a model turn", () => {
  for (const command of BUILTIN_COMMANDS) {
    expect(isAdvertisedSlash(command.name)).toBe(true);
    const result = dispatchSlash(command.name, "", session);
    expect(result.kind === "status" || result.kind === "error").toBe(true);
    if (result.kind === "status" || result.kind === "error") {
      expect(result.text.length).toBeGreaterThan(0);
    }
  }
});

test("usage reports session cost, buckets, occupancy, and model", () => {
  const usage = dispatchSlash("usage", "", session);
  expect(usage.kind).toBe("status");
  if (usage.kind !== "status") return;
  expect(usage.text).toContain("Session");
  expect(usage.text).toMatch(/\$\d+\.\d{4}/);
  expect(usage.text).toMatch(/\d+m \d+s/);
  expect(usage.text).toMatch(/[\d,]+ input/);
  expect(usage.text).toMatch(/[\d,]+ cache read/);
  expect(usage.text).toMatch(/[\d.]+[km]? \/ [\d.]+[km]? tokens/);
  expect(usage.text).toContain("Haiku 5.5");
  expect(usage.text).toContain("haiku · default · effort medium · fast off");
  expect(usage.text).toContain("Current session");
  expect(usage.text).toMatch(/\d+% used/);
});

test("usage with plan data matches Claude TUI rate-limit windows", () => {
  const usage = dispatchSlash("usage", "", {
    ...session,
    nowMs: Date.parse("2026-01-15T12:00:00Z"),
    timeZone: "UTC",
    plan: {
      windows: [
        {
          label: "Current session",
          utilization: 12,
          resetsAt: "2026-01-15T16:30:00Z",
        },
        {
          label: "Current week (all models)",
          utilization: 34,
          resetsAt: "2026-01-20T18:00:00Z",
        },
        {
          label: "Current week (Fable)",
          utilization: 5,
          resetsAt: "2026-01-20T18:00:00Z",
        },
      ],
      contributors: [
        { pct: 60, title: "Disable unused MCP servers" },
        { pct: 25, title: "Start a new session for a new task", detail: "run /clear" },
      ],
      mcpServers: [
        { name: "docs", pct: 60 },
        { name: "search", pct: 20 },
      ],
    },
  });
  expect(usage.kind).toBe("status");
  if (usage.kind !== "status") return;
  expect(usage.text).toContain("Current session");
  expect(usage.text).toContain("Current week (all models)");
  expect(usage.text).toContain("Current week (Fable)");
  expect(usage.text).toMatch(/\d+% used/);
  expect(usage.text).toMatch(/Resets .+\(UTC\)/);
  expect(usage.text).toContain("What's contributing to your limits usage?");
  expect(usage.text).toMatch(/\d+%\s+Disable unused MCP servers/);
  expect(usage.text).toContain("docs");
  expect(usage.text).toContain("search");
  expect(usage.text).toMatch(/[\d.]+[km]? \/ [\d.]+[km]? tokens/);
});

test("context reports occupancy, buckets, and mcp; all expands catalogs", () => {
  const context = dispatchSlash("context", "", session);
  expect(context.kind).toBe("status");
  if (context.kind !== "status") return;
  expect(context.text).toContain("Context Usage");
  expect(context.text).toContain("Haiku 5.5");
  expect(context.text).toContain("/tmp/app");
  expect(context.text).toContain("workspace");
  expect(context.text).toContain("/tmp/extra");
  expect(context.text).toContain("cache read");
  expect(context.text).toContain("/context all to expand");
  expect(context.text).not.toContain("Available models");

  const all = dispatchSlash("context", "all", session);
  expect(all.kind).toBe("status");
  if (all.kind !== "status") return;
  expect(all.text).toContain("Available models");
  expect(all.text).toContain("sonnet");
  expect(all.text).toContain("Effort levels");
  expect(all.text).not.toContain("/context all to expand");
});

test("compact token and occupancy helpers match native-style labels", () => {
  expect(formatCompactTokens(0)).toBe("0");
  expect(formatCompactTokens(900)).toBe("900");
  expect(formatCompactTokens(12_300)).toBe("12.3k");
  expect(formatCompactTokens(1_000_000)).toBe("1m");
  expect(occupancyPercent(12_300, 1_000_000)).toBeCloseTo(1.23, 2);
  expect(occupancyBar(0, 1_000_000)).toBe("░".repeat(20));
  expect(formatDuration(203_000)).toBe("3m 23s");
});

test("empty usage still has a full report instead of a one-liner", () => {
  const empty: SlashSessionView = {
    ...session,
    contextUsed: 0,
    usage: { ...EMPTY_USAGE },
    costUsd: 0,
    mcpServers: [],
    additionalDirectories: [],
  };
  const usage = formatUsage(empty);
  const context = formatContext(empty);
  expect(usage.split("\n").length).toBeGreaterThan(6);
  expect(context.split("\n").length).toBeGreaterThan(10);
  expect(usage).toContain("$0.0000");
  expect(context).toContain("(none)");
});

test("model effort and fast with args map to session config", () => {
  expect(dispatchSlash("model", "opus", session)).toMatchObject({
    kind: "config",
    configId: "model",
    value: "opus",
  });
  expect(dispatchSlash("effort", "high", session)).toMatchObject({
    kind: "config",
    configId: "effort",
    value: "high",
  });
  expect(dispatchSlash("fast", "on", session)).toMatchObject({
    kind: "config",
    configId: "fast",
    value: "on",
  });
});

test("only a whole-prompt slash is intercepted", () => {
  expect(parseSlashPrompt("/usage")).toEqual({ name: "usage", args: "" });
  expect(parseSlashPrompt("/model sonnet")).toEqual({ name: "model", args: "sonnet" });
  expect(parseSlashPrompt("please /usage")).toBeNull();
  expect(parseSlashPrompt("/usage and then explain")).toEqual({
    name: "usage",
    args: "and then explain",
  });
});

test("unknown config values fail closed instead of hanging a turn", () => {
  expect(dispatchSlash("model", "nope", session).kind).toBe("error");
  expect(dispatchSlash("effort", "ultra", session).kind).toBe("error");
  expect(dispatchSlash("fast", "maybe", session).kind).toBe("error");
});

test("rename requires a title and rejects --auto", () => {
  expect(dispatchSlash("rename", "", session)).toMatchObject({
    kind: "error",
    text: "Usage: /rename <title>",
  });
  expect(dispatchSlash("rename", "--auto", session).kind).toBe("error");
  expect(dispatchSlash("rename", "Ship it", session)).toEqual({
    kind: "rename",
    title: "Ship it",
  });
});
