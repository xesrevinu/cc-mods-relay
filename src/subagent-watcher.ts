import type { SessionMessage } from "./engine-watcher.js";
import {
  hasSubagentSpawn,
  sourceSubagentRows,
  type ListSubagents,
  type GetSubagentMessages,
} from "./subagent-source.js";

export const SUBAGENT_POLL_MS = 1000;

export interface SubagentWatcherOptions {
  sessionId: string;
  dir?: string;
  mainChain: SessionMessage[];
  listSubagents: ListSubagents;
  getSubagentMessages: GetSubagentMessages;
  onActivity: () => void | Promise<void>;
  schedule?: (fn: () => void, ms: number) => () => void;
  pollMs?: number;
}

export interface SubagentWatcher {
  update(mainChain: SessionMessage[]): void;
  stop(): void;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fn, ms);
  (handle as { unref?: () => void }).unref?.();
  return () => clearTimeout(handle);
};

export function createSubagentWatcher(opts: SubagentWatcherOptions): SubagentWatcher {
  const {
    sessionId,
    dir,
    listSubagents,
    getSubagentMessages,
    onActivity,
    schedule = defaultSchedule,
    pollMs = SUBAGENT_POLL_MS,
  } = opts;

  let mainChain = opts.mainChain;
  const seen = new Set<string>();
  let stopped = false;
  let cancelPending: (() => void) | undefined;

  const arm = (): void => {
    if (stopped) return;
    cancelPending = schedule(() => {
      cancelPending = undefined;
      void poll();
    }, pollMs);
  };

  const poll = async (): Promise<void> => {
    try {
      if (hasSubagentSpawn(mainChain)) {
        const rows = await sourceSubagentRows(sessionId, mainChain, {
          dir,
          listSubagents,
          getSubagentMessages,
        });
        const fresh: string[] = [];
        for (const row of rows) {
          const uuid = row.uuid;
          if (typeof uuid !== "string" || uuid === "") continue;
          if (!seen.has(uuid)) fresh.push(uuid);
        }
        if (fresh.length > 0 && !stopped) {
          for (const uuid of fresh) seen.add(uuid);
          await onActivity();
        }
      }
    } catch {
    }
    if (!stopped) arm();
  };

  arm();

  return {
    update(next: SessionMessage[]): void {
      mainChain = next;
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      cancelPending?.();
      cancelPending = undefined;
      seen.clear();
    },
  };
}
