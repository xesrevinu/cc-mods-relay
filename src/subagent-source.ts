import type { SessionMessage } from "./engine-watcher.js";

const SUBAGENT_TOOL_NAMES = new Set(["Task", "Agent"]);

export type ListSubagents = (sessionId: string, opts?: { dir?: string }) => Promise<string[]>;

export type GetSubagentMessages = (
  sessionId: string,
  agentId: string,
  opts?: { dir?: string },
) => Promise<SessionMessage[]>;

export const defaultListSubagents: ListSubagents = async (sessionId, opts) => {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return sdk.listSubagents(sessionId, opts) as Promise<string[]>;
};

export const defaultGetSubagentMessages: GetSubagentMessages = async (sessionId, agentId, opts) => {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return sdk.getSubagentMessages(sessionId, agentId, opts) as Promise<SessionMessage[]>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasSubagentSpawn(mainChain: SessionMessage[]): boolean {
  for (const msg of mainChain) {
    if (!isObject(msg)) continue;
    const inner = msg.message;
    if (!isObject(inner)) continue;
    const content = inner.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        isObject(block) &&
        block.type === "tool_use" &&
        typeof block.name === "string" &&
        SUBAGENT_TOOL_NAMES.has(block.name)
      ) {
        return true;
      }
    }
  }
  return false;
}

export function spawnIdsOpen(mainChain: SessionMessage[]): boolean {
  const spawnIds = new Set<string>();
  const closedIds = new Set<string>();
  for (const msg of mainChain) {
    if (!isObject(msg)) continue;
    const inner = msg.message;
    if (!isObject(inner)) continue;
    const content = inner.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isObject(block)) continue;
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string" &&
        SUBAGENT_TOOL_NAMES.has(block.name)
      ) {
        spawnIds.add(block.id);
      } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        closedIds.add(block.tool_use_id);
      }
    }
  }
  for (const id of spawnIds) {
    if (!closedIds.has(id)) return true;
  }
  return false;
}

export async function sourceSubagentRows(
  sessionId: string,
  mainChain: SessionMessage[],
  opts: { dir?: string; listSubagents: ListSubagents; getSubagentMessages: GetSubagentMessages },
): Promise<SessionMessage[]> {
  if (!hasSubagentSpawn(mainChain)) return [];

  const { dir, listSubagents, getSubagentMessages } = opts;
  const agentIds = await listSubagents(sessionId, { dir });

  const rows: SessionMessage[] = [];
  for (const agentId of agentIds) {
    const agentRows = await getSubagentMessages(sessionId, agentId, { dir });
    rows.push(...agentRows);
  }
  return rows;
}
