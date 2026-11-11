import { expect, test } from "bun:test";
import { BUILTIN_COMMANDS } from "../src/command-catalog.js";
import { dispatchSlash, isAdvertisedSlash, parseSlashPrompt } from "../src/slash.js";
import { EMPTY_USAGE } from "../src/usage.js";

const session = {
  cwd: "/tmp/app",
  model: "sonnet",
  mode: "default",
  effort: "medium",
  fast: false,
  models: ["default", "sonnet", "opus", "haiku"],
  effortLevels: ["default", "low", "medium", "high"],
  contextUsed: 12345,
  contextSize: 1_000_000,
  usage: { ...EMPTY_USAGE, inputTokens: 1000, outputTokens: 80 },
  costUsd: 0.04,
};

test("every advertised slash is handled without a model turn", () => {
  for (const command of BUILTIN_COMMANDS) {
    expect(isAdvertisedSlash(command.name)).toBe(true);
    const result = dispatchSlash(command.name, "", session);
    expect(result.kind === "status" || result.kind === "error").toBe(true);
    if (result.kind !== "config") expect(result.text.length).toBeGreaterThan(0);
  }
});

test("usage and context report session state", () => {
  const usage = dispatchSlash("usage", "", session);
  expect(usage.kind).toBe("status");
  if (usage.kind === "status") {
    expect(usage.text).toContain("12,345 / 1,000,000");
    expect(usage.text).toContain("1,000 in");
    expect(usage.text).toContain("$0.0400");
  }
  const context = dispatchSlash("context", "", session);
  expect(context.kind).toBe("status");
  if (context.kind === "status") {
    expect(context.text).toContain("/tmp/app");
    expect(context.text).toContain("model: sonnet");
    expect(context.text).toContain("effort: medium");
  }
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
