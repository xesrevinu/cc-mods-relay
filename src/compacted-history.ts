import { globSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionMessage } from "./engine-watcher.js";

function defaultFindTranscript(sessionId: string): string[] {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return globSync(join(configDir, "projects", "**", `${sessionId}.jsonl`));
}

export interface PrecompactHistoryOptions {
  findTranscript?: (sessionId: string) => string[];
  hydrateToolUseResult?: boolean;
}

export async function withPrecompactHistory(
  sessionId: string,
  messages: SessionMessage[],
  opts: PrecompactHistoryOptions = {},
): Promise<SessionMessage[]> {
  if (!startsWithCompactSummary(messages)) return messages;
  let file: string | undefined;
  try {
    file = (opts.findTranscript ?? defaultFindTranscript)(sessionId)[0];
  } catch {
    return messages;
  }
  if (!file) return messages;
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return messages;
  }
  const earlier = precompactMessages(parseTranscript(text), sessionId, {
    hydrateToolUseResult: opts.hydrateToolUseResult,
  });
  if (earlier.length === 0) return messages;
  const seen = new Set(messages.map((message) => message.uuid));
  return [...earlier.filter((message) => !seen.has(message.uuid)), ...messages];
}

type TranscriptRecord = {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  logicalParentUuid?: string | null;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: unknown;
  timestamp?: string;
  toolUseResult?: unknown;
  line: number;
};

export function parseTranscript(text: string): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
  const lines = text.split("\n");
  for (let line = 0; line < lines.length; line++) {
    if (!lines[line].trim()) continue;
    try {
      const parsed: unknown = JSON.parse(lines[line]);
      if (parsed && typeof parsed === "object") records.push({ ...parsed, line });
    } catch {
    }
  }
  return records;
}

function isBoundary(record: TranscriptRecord): boolean {
  return record.type === "system" && record.subtype === "compact_boundary";
}

function isMainChain(record: TranscriptRecord): boolean {
  return typeof record.uuid === "string" && record.isSidechain !== true;
}

export function precompactMessages(
  records: TranscriptRecord[],
  sessionId: string,
  opts: { hydrateToolUseResult?: boolean } = {},
): SessionMessage[] {
  const byUuid = new Map<string, TranscriptRecord>();
  for (const record of records) if (record.uuid) byUuid.set(record.uuid, record);

  const boundaries = records.filter(isBoundary);
  const last = boundaries[boundaries.length - 1];
  if (!last) return [];

  const continuation = (boundary: TranscriptRecord): TranscriptRecord | undefined => {
    const logical = boundary.logicalParentUuid ? byUuid.get(boundary.logicalParentUuid) : undefined;
    if (logical) return logical;
    for (let i = records.indexOf(boundary) - 1; i >= 0; i--) {
      if (isMainChain(records[i]) && !isBoundary(records[i])) return records[i];
    }
    return undefined;
  };

  const chain: TranscriptRecord[] = [];
  const visited = new Set<string>();
  let cursor = continuation(last);
  while (cursor && cursor.uuid && !visited.has(cursor.uuid)) {
    visited.add(cursor.uuid);
    if (isBoundary(cursor)) {
      cursor = continuation(cursor);
      continue;
    }
    chain.push(cursor);
    cursor = cursor.parentUuid ? byUuid.get(cursor.parentUuid) : undefined;
  }

  return chain
    .reverse()
    .filter(
      (record) =>
        (record.type === "user" || record.type === "assistant") &&
        record.isMeta !== true &&
        record.isSidechain !== true,
    )
    .map(
      (record) =>
        ({
          type: record.type as "user" | "assistant",
          uuid: record.uuid as string,
          session_id: sessionId,
          message: record.message,
          parent_tool_use_id: null,
          parent_agent_id: null,
          ...(record.isCompactSummary ? { isCompactSummary: true } : {}),
          is_meta: false,
          ...(record.timestamp ? { timestamp: record.timestamp } : {}),
          ...(opts.hydrateToolUseResult && record.toolUseResult !== undefined
            ? { toolUseResult: record.toolUseResult }
            : {}),
        }) as SessionMessage,
    );
}

function startsWithCompactSummary(messages: SessionMessage[]): boolean {
  const first = messages[0] as { isCompactSummary?: unknown } | undefined;
  return first?.isCompactSummary === true;
}
