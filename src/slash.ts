import { BUILTIN_COMMANDS } from "./command-catalog.js";
import type { AccumulatedUsage } from "./usage.js";

export type ParsedSlash = { name: string; args: string };

const ADVERTISED = new Set(BUILTIN_COMMANDS.map((command) => command.name));
const BAR_WIDTH = 20;

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
  modelDisplayName: string;
  mode: string;
  effort: string;
  fast: boolean;
  models: string[];
  effortLevels: string[];
  contextUsed: number;
  contextSize: number;
  usage: AccumulatedUsage;
  costUsd?: number;
  mcpServers: string[];
  additionalDirectories: string[];
  startedAtMs?: number;
  nowMs?: number;
};

export type SlashResult =
  | { kind: "config"; configId: "model" | "effort" | "fast"; value: string; text: string }
  | { kind: "status"; text: string }
  | { kind: "error"; text: string };

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatCompactTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) {
    const value = n / 1_000_000;
    return `${trimFloat(value, value >= 10 ? 0 : 1)}m`;
  }
  if (abs >= 1000) {
    const value = n / 1000;
    return `${trimFloat(value, value >= 100 ? 0 : 1)}k`;
  }
  return String(Math.round(n));
}

function trimFloat(value: number, digits: number): string {
  if (digits === 0) return String(Math.round(value));
  return value.toFixed(digits).replace(/\.0+$/, "");
}

export function occupancyPercent(used: number, size: number): number {
  if (!(size > 0) || !(used >= 0)) return 0;
  return Math.min(100, Math.max(0, (used / size) * 100));
}

export function occupancyBar(used: number, size: number, width = BAR_WIDTH): string {
  const pct = occupancyPercent(used, size);
  const filled = size > 0 ? Math.round((pct / 100) * width) : 0;
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}

function formatPercent(used: number, size: number): string {
  const pct = occupancyPercent(used, size);
  return pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}

function contextLine(used: number, size: number): string {
  return `${formatCompactTokens(used)} / ${formatCompactTokens(size)} tokens (${formatPercent(used, size)})`;
}

function padLabel(label: string, width = 16): string {
  return label.length >= width ? label : `${label}${" ".repeat(width - label.length)}`;
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function tokenBuckets(usage: AccumulatedUsage): string {
  return [
    `${formatCount(usage.inputTokens)} input`,
    `${formatCount(usage.outputTokens)} output`,
    `${formatCount(usage.cachedReadTokens)} cache read`,
    `${formatCount(usage.cachedWriteTokens)} cache write`,
  ].join(", ");
}

function namedList(items: string[], empty: string): string[] {
  if (items.length === 0) return [`  ${empty}`];
  return items.map((item) => `  ${item}`);
}

export function formatUsage(session: SlashSessionView): string {
  const lines = [
    "Session",
    `  ${padLabel("Total cost:")}${typeof session.costUsd === "number" ? formatUsd(session.costUsd) : "n/a"}`,
  ];
  if (typeof session.startedAtMs === "number") {
    const now = session.nowMs ?? Date.now();
    lines.push(`  ${padLabel("Wall time:")}${formatDuration(now - session.startedAtMs)}`);
  }
  lines.push(
    `  ${padLabel("Usage:")}${tokenBuckets(session.usage)}`,
    `  ${padLabel("Context:")}${contextLine(session.contextUsed, session.contextSize)}`,
    "",
    "Current session",
    `  ${occupancyBar(session.contextUsed, session.contextSize)}  ${formatPercent(session.contextUsed, session.contextSize)} used`,
    "",
    `${session.modelDisplayName}`,
    `${session.model} · ${session.mode} · effort ${session.effort} · fast ${session.fast ? "on" : "off"}`,
  );
  return lines.join("\n");
}

export function formatContext(session: SlashSessionView, expanded = false): string {
  const lines = [
    "Context Usage",
    `  ${session.modelDisplayName}`,
    `  ${session.model}`,
    `  ${contextLine(session.contextUsed, session.contextSize)}`,
    "",
    `  ${occupancyBar(session.contextUsed, session.contextSize)}`,
    "",
    "Session",
    `  ${padLabel("cwd:")}${session.cwd}`,
    `  ${padLabel("mode:")}${session.mode}`,
    `  ${padLabel("effort:")}${session.effort}`,
    `  ${padLabel("fast:")}${session.fast ? "on" : "off"}`,
    "",
    "Token buckets",
    `  ${padLabel("input")}${formatCount(session.usage.inputTokens)}`,
    `  ${padLabel("output")}${formatCount(session.usage.outputTokens)}`,
    `  ${padLabel("cache read")}${formatCount(session.usage.cachedReadTokens)}`,
    `  ${padLabel("cache write")}${formatCount(session.usage.cachedWriteTokens)}`,
    "",
    "MCP servers",
    ...namedList(session.mcpServers, "(none)"),
  ];
  if (session.additionalDirectories.length > 0 || expanded) {
    lines.push("", "Additional directories", ...namedList(session.additionalDirectories, "(none)"));
  }
  if (expanded) {
    lines.push("", "Available models", ...namedList(session.models, "(none)"));
    lines.push("", "Effort levels", ...namedList(session.effortLevels, "(none)"));
  } else {
    lines.push("", "/context all to expand");
  }
  return lines.join("\n");
}

export function dispatchSlash(name: string, args: string, session: SlashSessionView): SlashResult {
  switch (name) {
    case "usage":
      return { kind: "status", text: formatUsage(session) };
    case "context":
      return { kind: "status", text: formatContext(session, args === "all") };
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
