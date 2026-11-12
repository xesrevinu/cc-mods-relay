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
  contextUsed: 21900,
  contextSize: 1_000_000,
  usage: {
    ...EMPTY_USAGE,
    inputTokens: 3400,
    outputTokens: 80,
    cachedReadTokens: 800,
    cachedWriteTokens: 50,
  },
  costUsd: 0.04,
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
    if (result.kind !== "config") expect(result.text.length).toBeGreaterThan(0);
  }
});

test("usage reports session cost, buckets, occupancy, and model", () => {
  const usage = dispatchSlash("usage", "", session);
  expect(usage.kind).toBe("status");
  if (usage.kind !== "status") return;
  expect(usage.text).toContain("Session");
  expect(usage.text).toContain("$0.0400");
  expect(usage.text).toContain("3m 23s");
  expect(usage.text).toContain("3,400 input");
  expect(usage.text).toContain("800 cache read");
  expect(usage.text).toContain("21.9k / 1m tokens");
  expect(usage.text).toContain("Haiku 5.5");
  expect(usage.text).toContain("haiku · default · effort medium · fast off");
  expect(usage.text).toContain("Current session");
  expect(usage.text).toContain("% used");
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
  expect(formatCompactTokens(21900)).toBe("21.9k");
  expect(formatCompactTokens(1_000_000)).toBe("1m");
  expect(occupancyPercent(21900, 1_000_000)).toBeCloseTo(2.19, 2);
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
