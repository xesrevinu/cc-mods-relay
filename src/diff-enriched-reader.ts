import { readFileSync } from "node:fs";
import { findTranscript as defaultFindTranscript } from "./jsonl.js";
import type { GetMessages, SessionMessage } from "./engine-watcher.js";

export function toolUseResultMap(rawLines: string[]): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const line of rawLines) {
    if (line.trim() === "") continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec === null || typeof rec !== "object") continue;
    const { uuid, toolUseResult } = rec as { uuid?: unknown; toolUseResult?: unknown };
    if (typeof uuid === "string" && toolUseResult !== undefined) {
      map.set(uuid, toolUseResult);
    }
  }
  return map;
}

export interface DiffEnrichedReaderOptions {
  findTranscript?: (sessionId: string) => string[];
  readRawLines?: (path: string) => string[];
  onRawLines?: (sessionId: string, lines: string[]) => void;
}

export function createDiffEnrichedReader(
  base: GetMessages,
  opts: DiffEnrichedReaderOptions = {},
): GetMessages {
  const findTranscript = opts.findTranscript ?? defaultFindTranscript;
  const readRawLines =
    opts.readRawLines ?? ((path: string) => readFileSync(path, "utf8").split("\n"));

  return async (sessionId: string, readerOpts?: { dir?: string }): Promise<SessionMessage[]> => {
    const reduced = await base(sessionId, readerOpts);

    let path: string | undefined;
    try {
      path = findTranscript(sessionId)[0];
    } catch {
      return reduced;
    }
    if (!path) return reduced;

    let raw: string[];
    try {
      raw = readRawLines(path);
    } catch {
      return reduced;
    }

    opts.onRawLines?.(sessionId, raw);

    const map = toolUseResultMap(raw);
    if (map.size === 0) return reduced;

    return reduced.map((m) =>
      typeof m.uuid === "string" && map.has(m.uuid) ? { ...m, toolUseResult: map.get(m.uuid) } : m,
    );
  };
}
