import { BUILTIN_COMMANDS } from "./command-catalog.js";
import type { AccumulatedUsage } from "./usage.js";

export type ParsedSlash = { name: string; args: string };

const ADVERTISED = new Set(BUILTIN_COMMANDS.map((command) => command.name));

export function parseSlashPrompt(text: string): ParsedSlash | null {
  const trimmed = text.trim();
  const match = /^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  return { name: match[1]!, args: (match[2] ?? "").trim() };
}

export function isAdvertisedSlash(name: string): boolean {
  return ADVERTISED.has(name);
}

export type SlashSessionView = {
  cwd: string;
  model: string;
  mode: string;
  effort: string;
  fast: boolean;
  models: string[];
  effortLevels: string[];
  contextUsed: number;
  contextSize: number;
  usage: AccumulatedUsage;
  costUsd?: number;
};

export type SlashResult =
  | { kind: "config"; configId: "model" | "effort" | "fast"; value: string; text: string }
  | { kind: "status"; text: string }
  | { kind: "error"; text: string };

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatUsage(session: SlashSessionView): string {
  const lines = [
    `context: ${formatCount(session.contextUsed)} / ${formatCount(session.contextSize)} tokens`,
    `session: ${formatCount(session.usage.inputTokens)} in, ${formatCount(session.usage.outputTokens)} out`,
  ];
  if (typeof session.costUsd === "number") lines.push(`cost: $${session.costUsd.toFixed(4)} USD`);
  return lines.join("\n");
}

export function formatContext(session: SlashSessionView): string {
  return [
    `cwd: ${session.cwd}`,
    `model: ${session.model}`,
    `mode: ${session.mode}`,
    `effort: ${session.effort}`,
    `fast: ${session.fast ? "on" : "off"}`,
    `context: ${formatCount(session.contextUsed)} / ${formatCount(session.contextSize)} tokens`,
  ].join("\n");
}

export function dispatchSlash(name: string, args: string, session: SlashSessionView): SlashResult {
  switch (name) {
    case "usage":
      return { kind: "status", text: formatUsage(session) };
    case "context":
      return { kind: "status", text: formatContext(session) };
    case "model": {
      if (!args) return { kind: "status", text: `model: ${session.model}` };
      if (!session.models.includes(args)) {
        return { kind: "error", text: `Unknown model ${args}. Available: ${session.models.join(", ")}` };
      }
      return { kind: "config", configId: "model", value: args, text: `model: ${args}` };
    }
    case "effort": {
      if (!args) return { kind: "status", text: `effort: ${session.effort}` };
      const allowed = ["default", ...session.effortLevels];
      if (!allowed.includes(args)) {
        return { kind: "error", text: `Unknown effort ${args}. Available: ${allowed.join(", ")}` };
      }
      return { kind: "config", configId: "effort", value: args, text: `effort: ${args}` };
    }
    case "fast": {
      if (!args) return { kind: "status", text: `fast: ${session.fast ? "on" : "off"}` };
      if (args !== "on" && args !== "off") {
        return { kind: "error", text: "fast expects on or off" };
      }
      return { kind: "config", configId: "fast", value: args, text: `fast: ${args}` };
    }
    default:
      return { kind: "error", text: `Unsupported command /${name}` };
  }
}
