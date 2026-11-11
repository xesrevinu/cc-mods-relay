import type { SessionMessage } from "./engine-watcher.js";
import type { ToolUseCorrelator } from "./permissions/request-permission.js";

export interface SidechainToolUse {
  id: string;
  parentId: string | null;
  toolName: string;
  toolInput: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function collectSidechainToolUses(rows: SessionMessage[]): SidechainToolUse[] {
  const uses: SidechainToolUse[] = [];
  for (const row of rows) {
    if (!isObject(row)) continue;
    if (row.type !== "assistant") continue;
    const rawParent = row.parent_tool_use_id;
    const parentId = typeof rawParent === "string" && rawParent.length > 0 ? rawParent : null;
    if (row.isSidechain !== true && parentId === null) continue;

    const inner = row.message;
    if (!isObject(inner)) continue;
    const content = inner.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type !== "tool_use") continue;
      if (typeof block.id !== "string" || typeof block.name !== "string") continue;
      uses.push({
        id: block.id,
        parentId,
        toolName: block.name,
        toolInput: block.input,
      });
    }
  }
  return uses;
}

export function registerSidechainGateToolUses(
  uses: SidechainToolUse[],
  correlator: ToolUseCorrelator,
  registered: Set<string>,
  parentMap: Map<string, SidechainToolUse>,
): void {
  for (const use of uses) {
    if (registered.has(use.id)) continue;
    correlator.register(use.id);
    registered.add(use.id);
    parentMap.set(use.id, use);
  }
}
