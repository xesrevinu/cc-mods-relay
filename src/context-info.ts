/** Map Claude TUI `contextUsage` JSONL onto Grok's `x.ai/session/info` ContextInfo. */

const CORE_LABELS = new Set(["System prompt", "Messages", "Free space", "System tools", "MCP tools"]);

export type GrokContextCategory = {
  label: string;
  tokens: number;
  detail?: string;
};

export type GrokContextInfo = {
  used: number;
  total: number;
  systemPromptTokens: number;
  toolDefinitionsCount: number;
  toolDefinitionsTokens: number;
  compactionCount: number;
  turnCount: number;
  toolCallCount: number;
  messageCount: number;
  messageTokens: number;
  freeTokens: number;
  usagePct: number;
  autoCompactThresholdPercent: number;
  usageCategories: GrokContextCategory[];
};

export type ContextUsageSnapshot = {
  model?: unknown;
  total_tokens?: unknown;
  raw_max_tokens?: unknown;
  percentage?: unknown;
  categories?: unknown;
  mcp_tools?: unknown;
  system_tools?: unknown;
  systemTools?: unknown;
  skills?: unknown;
};

function countDetail(count: number, noun: string): string | undefined {
  if (!(count > 0)) return undefined;
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function skillCount(snapshot: ContextUsageSnapshot | undefined): number {
  return Array.isArray(snapshot?.skills) ? snapshot.skills.length : 0;
}

function mcpServerCount(snapshot: ContextUsageSnapshot | undefined, fallback: string[]): number {
  if (Array.isArray(snapshot?.mcp_tools)) {
    const names = new Set<string>();
    for (const tool of snapshot.mcp_tools) {
      if (!tool || typeof tool !== "object") continue;
      const server = (tool as { server_name?: unknown }).server_name;
      if (typeof server === "string" && server.length > 0) names.add(server);
    }
    if (names.size > 0) return names.size;
  }
  return fallback.length;
}

function tokensOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function categoryTokens(snapshot: ContextUsageSnapshot | undefined, name: string): number {
  if (!Array.isArray(snapshot?.categories)) return 0;
  let sum = 0;
  for (const row of snapshot.categories) {
    if (!row || typeof row !== "object") continue;
    const rec = row as { name?: unknown; tokens?: unknown };
    if (rec.name === name) sum += tokensOf(rec.tokens);
  }
  return sum;
}

function toolCount(snapshot: ContextUsageSnapshot | undefined): number {
  const mcp = Array.isArray(snapshot?.mcp_tools) ? snapshot.mcp_tools.length : 0;
  const system = Array.isArray(snapshot?.system_tools)
    ? snapshot.system_tools.length
    : Array.isArray(snapshot?.systemTools)
      ? snapshot.systemTools.length
      : 0;
  return mcp + system;
}

function extraCategories(
  snapshot: ContextUsageSnapshot | undefined,
  mcpServers: string[],
): GrokContextCategory[] {
  const categories: GrokContextCategory[] = [];
  if (Array.isArray(snapshot?.categories)) {
    for (const row of snapshot.categories) {
      if (!row || typeof row !== "object") continue;
      const rec = row as { name?: unknown; tokens?: unknown; kind?: unknown };
      if (typeof rec.name !== "string" || rec.name.length === 0) continue;
      if (CORE_LABELS.has(rec.name)) continue;
      if (rec.kind === "free" || rec.kind === "deferred") continue;
      let detail: string | undefined;
      if (rec.name === "Skills") detail = countDetail(skillCount(snapshot), "skill");
      else if (rec.name === "MCP server instructions") {
        detail = countDetail(mcpServerCount(snapshot, mcpServers), "server");
      }
      categories.push({ label: rec.name, tokens: tokensOf(rec.tokens), detail });
    }
  }
  if (categories.length === 0 && mcpServers.length > 0) {
    categories.push({
      label: "MCP servers",
      tokens: 0,
      detail: `${mcpServers.length} server${mcpServers.length === 1 ? "" : "s"}`,
    });
  }
  return categories;
}

export function grokContextFromSnapshot(
  snapshot: ContextUsageSnapshot | undefined,
  fallback: { used: number; total: number; mcpServers?: string[] },
): GrokContextInfo {
  const usedFromSnapshot = tokensOf(snapshot?.total_tokens);
  const totalFromSnapshot = tokensOf(snapshot?.raw_max_tokens);
  const used = usedFromSnapshot > 0 ? usedFromSnapshot : Math.max(0, Math.round(fallback.used));
  const total = Math.max(used, totalFromSnapshot > 0 ? totalFromSnapshot : Math.round(fallback.total) || 1);
  const systemPromptTokens = categoryTokens(snapshot, "System prompt");
  const messageTokens = categoryTokens(snapshot, "Messages") || (usedFromSnapshot > 0 ? 0 : used);
  const toolDefinitionsTokens = categoryTokens(snapshot, "System tools") + categoryTokens(snapshot, "MCP tools");
  const freeFromSnapshot = categoryTokens(snapshot, "Free space");
  const usagePct =
    typeof snapshot?.percentage === "number" && Number.isFinite(snapshot.percentage)
      ? Math.min(100, Math.max(0, Math.round(snapshot.percentage)))
      : total > 0
        ? Math.min(100, Math.round((used / total) * 100))
        : 0;
  return {
    used,
    total,
    systemPromptTokens,
    toolDefinitionsCount: toolCount(snapshot),
    toolDefinitionsTokens,
    compactionCount: 0,
    turnCount: 0,
    toolCallCount: 0,
    messageCount: 0,
    messageTokens,
    freeTokens: freeFromSnapshot > 0 ? freeFromSnapshot : Math.max(0, total - used),
    usagePct,
    autoCompactThresholdPercent: 85,
    usageCategories: extraCategories(snapshot, fallback.mcpServers ?? []),
  };
}

export function parseCompactTokens(raw: string): number | undefined {
  const match = /^([\d.]+)\s*([kKmM])?$/.exec(raw.trim().replace(/,/g, ""));
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  const suffix = match[2]?.toLowerCase();
  if (suffix === "m") return Math.round(value * 1_000_000);
  if (suffix === "k") return Math.round(value * 1_000);
  return Math.round(value);
}

export function parseContextMarkdown(text: string): ContextUsageSnapshot | undefined {
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
  if (!/Context Usage|Estimated usage by category/i.test(stripped)) return undefined;
  const totals = /\*\*Tokens:\*\*\s*([\d.,]+[km]?)\s*\/\s*([\d.,]+[km]?)\s*\((\d+)%\)/i.exec(stripped)
    ?? /([\d.,]+[km]?)\s*\/\s*([\d.,]+[km]?)\s*tokens\s*\((\d+)%\)/i.exec(stripped);
  const categories: Array<{ name: string; tokens: number; kind: string }> = [];
  for (const row of stripped.matchAll(/\|\s*([^|]+?)\s*\|\s*([\d.,]+[km]?)\s*\|\s*[\d.]+%\s*\|/gi)) {
    const name = row[1]!.replace(/\*+/g, "").trim();
    if (/^category$/i.test(name) || /^-+$/.test(name)) continue;
    const tokens = parseCompactTokens(row[2]!);
    if (tokens === undefined) continue;
    const kind = /deferred/i.test(name)
      ? "deferred"
      : /free space/i.test(name)
        ? "free"
        : /buffer/i.test(name)
          ? "buffer"
          : "used";
    categories.push({ name, tokens, kind });
  }
  if (categories.length === 0 && !totals) return undefined;
  const used = totals ? parseCompactTokens(totals[1]!) : undefined;
  const total = totals ? parseCompactTokens(totals[2]!) : undefined;
  const percentage = totals ? Number(totals[3]) : undefined;
  const mcp_tools = [...stripped.matchAll(/\|\s*(mcp__[^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([\d.,]+[km]?)\s*\|/gi)].map(
    (row) => ({
      name: row[1]!.trim(),
      server_name: row[2]!.trim(),
      tokens: parseCompactTokens(row[3]!) ?? 0,
    }),
  );
  const skills = [...stripped.matchAll(/^\|\s*([^|]+?)\s*\|\s*(Built-in|User|Project)[^|]*\|/gim)].map((row) => ({
    name: row[1]!.trim(),
  }));
  return {
    total_tokens: used,
    raw_max_tokens: total,
    percentage: Number.isFinite(percentage) ? percentage : undefined,
    categories,
    mcp_tools,
    skills,
  };
}

function recordText(rec: { content?: unknown; message?: unknown }): string {
  const chunks: string[] = [];
  const take = (value: unknown) => {
    if (typeof value === "string") {
      chunks.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) take(item);
      return;
    }
    if (value && typeof value === "object") {
      const rec = value as { type?: unknown; text?: unknown; content?: unknown };
      if (typeof rec.text === "string") chunks.push(rec.text);
      else if (rec.content !== undefined) take(rec.content);
    }
  };
  take(rec.content);
  take(rec.message);
  return chunks.join("\n");
}

export function scanContextUsageFromJsonl(contents: string): ContextUsageSnapshot | undefined {
  const lines = contents.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as {
        contextUsage?: unknown;
        content?: unknown;
        message?: unknown;
      };
      const value = rec?.contextUsage;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as ContextUsageSnapshot;
      }
      const fromMarkdown = parseContextMarkdown(recordText(rec));
      if (fromMarkdown) return fromMarkdown;
    } catch {
      continue;
    }
  }
  return undefined;
}
