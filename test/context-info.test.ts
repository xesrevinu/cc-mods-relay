import { expect, test } from "bun:test";
import {
  grokContextFromSnapshot,
  parseCompactTokens,
  parseContextMarkdown,
  scanContextUsageFromJsonl,
} from "../src/context-info.js";

const snapshot = {
  total_tokens: 100_000,
  raw_max_tokens: 1_000_000,
  percentage: 10,
  categories: [
    { name: "System prompt", tokens: 3_000, kind: "used" },
    { name: "System tools", tokens: 2_000, kind: "used" },
    { name: "MCP tools", tokens: 4_000, kind: "used" },
    { name: "MCP server instructions", tokens: 500, kind: "used" },
    { name: "MCP tools (deferred)", tokens: 1_000, kind: "deferred" },
    { name: "Skills", tokens: 2_000, kind: "used" },
    { name: "Messages", tokens: 80_000, kind: "used" },
    { name: "Autocompact buffer", tokens: 20_000, kind: "buffer" },
    { name: "Free space", tokens: 900_000, kind: "free" },
  ],
  mcp_tools: [
    { name: "mcp__docs__Read", server_name: "docs" },
    { name: "mcp__search__Query", server_name: "search" },
  ],
  skills: [{ name: "alpha" }, { name: "beta" }],
};

test("Claude contextUsage maps onto Grok ContextInfo fields", () => {
  const info = grokContextFromSnapshot(snapshot, { used: 0, total: 1_000_000 });
  expect(info.used).toBeGreaterThan(0);
  expect(info.total).toBeGreaterThan(info.used);
  expect(info.usagePct).toBeGreaterThan(0);
  expect(info.systemPromptTokens).toBeGreaterThan(0);
  expect(info.messageTokens).toBeGreaterThan(info.systemPromptTokens);
  expect(info.toolDefinitionsTokens).toBeGreaterThan(0);
  expect(info.toolDefinitionsCount).toBe(2);
  expect(info.freeTokens).toBeGreaterThan(0);
  expect(info.usageCategories.map((row) => row.label)).toEqual([
    "MCP server instructions",
    "Skills",
    "Autocompact buffer",
  ]);
  expect(info.usageCategories.find((row) => row.label === "Skills")?.detail).toMatch(/^\d+ skills?$/);
  expect(info.usageCategories.find((row) => row.label === "MCP server instructions")?.detail).toMatch(
    /^\d+ servers?$/,
  );
});

test("scanContextUsageFromJsonl reads the latest local-command snapshot", () => {
  const jsonl = [
    `{"type":"user","uuid":"a"}`,
    `{"type":"user","uuid":"b","contextUsage":${JSON.stringify(snapshot)}}`,
    `{"type":"assistant","uuid":"c"}`,
    `{not json`,
  ].join("\n");
  const scanned = scanContextUsageFromJsonl(jsonl);
  expect(scanned?.total_tokens).toBeGreaterThan(0);
  expect(scanned?.raw_max_tokens).toBeGreaterThan(0);
});

test("Claude 2.1 /context markdown is parsed when contextUsage is absent", () => {
  expect(parseCompactTokens("4.7k")).toBe(4_700);
  expect(parseCompactTokens("1m")).toBe(1_000_000);
  const md = `## Context Usage

**Model:** claude-haiku-5-5  
**Tokens:** 10k / 1m (1%)

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 3k | 0.3% |
| System tools | 2k | 0.2% |
| MCP tools | 400 | 0.0% |
| Messages | 10 | 0.0% |
| Free space | 990k | 99.0% |

### MCP Tools
| Tool | Server | Tokens |
|------|--------|--------|
| mcp__docs__Read | docs | 200 |
`;
  const parsed = parseContextMarkdown(md);
  expect(parsed?.total_tokens).toBeGreaterThan(0);
  expect(parsed?.raw_max_tokens).toBe(1_000_000);
  expect(parsed?.percentage).toBeGreaterThanOrEqual(0);
  const info = grokContextFromSnapshot(parsed, { used: 0, total: 1_000_000 });
  expect(info.systemPromptTokens).toBeGreaterThan(0);
  expect(info.toolDefinitionsTokens).toBeGreaterThan(0);
  expect(info.messageTokens).toBeGreaterThanOrEqual(0);
  expect(info.toolDefinitionsCount).toBe(1);

  const jsonl = JSON.stringify({
    type: "user",
    isMeta: true,
    message: { role: "user", content: md },
  });
  expect(scanContextUsageFromJsonl(jsonl)?.total_tokens).toBeGreaterThan(0);
});

test("without a snapshot, occupancy falls through to session used/total", () => {
  const info = grokContextFromSnapshot(undefined, { used: 10_000, total: 1_000_000, mcpServers: ["docs"] });
  expect(info.used).toBeGreaterThan(0);
  expect(info.messageTokens).toBe(info.used);
  expect(info.systemPromptTokens).toBe(0);
  expect(info.usageCategories).toEqual([{ label: "MCP servers", tokens: 0, detail: "1 server" }]);
});
