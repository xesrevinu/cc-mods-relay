import type { SessionWatcher } from "./engine-lifecycle.js";
import { tailTranscript } from "./jsonl.js";
import type { TranscriptTail, TailOptions } from "./jsonl.js";

export type SessionMessage = { uuid?: string; [k: string]: unknown };

export type GetMessages = (
  sessionId: string,
  opts?: { dir?: string },
) => Promise<SessionMessage[]> | SessionMessage[];

export const DEFAULT_WATCHER_DEBOUNCE_MS = 50;

export interface JsonlWatcherOptions {
  sessionId: string;
  transcriptPath: string;
  dir?: string;
  onEvent: (message?: SessionMessage) => void;
  getMessages?: GetMessages;
  tail?: (path: string, opts: TailOptions) => TranscriptTail;
  debounceMs?: number;
  schedule?: (fn: () => void, ms: number) => () => void;
}

export interface JsonlWatcher extends SessionWatcher {
  stop(): void;
  notifyEndOfTurn(): void;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
}

/**
 * Tail the host JSONL for new bytes and wake the agent. Parsing the whole
 * transcript is pumpUpdates' job (and is skipped once Mods is live).
 */
export function createJsonlWatcher(opts: JsonlWatcherOptions): JsonlWatcher {
  const {
    transcriptPath,
    onEvent,
    tail = tailTranscript,
    debounceMs = DEFAULT_WATCHER_DEBOUNCE_MS,
    schedule = defaultSchedule,
  } = opts;

  let stopped = false;
  let cancelDebounce: (() => void) | undefined;

  const notify = (): void => {
    if (stopped) return;
    onEvent();
  };

  const scheduleNotify = (): void => {
    if (stopped) return;
    cancelDebounce?.();
    cancelDebounce = schedule(() => {
      cancelDebounce = undefined;
      notify();
    }, debounceMs);
  };

  const transcriptTail = tail(transcriptPath, {
    onRecord: () => scheduleNotify(),
  });

  return {
    notifyEndOfTurn(): void {
      if (stopped) return;
      cancelDebounce?.();
      cancelDebounce = undefined;
      notify();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      cancelDebounce?.();
      cancelDebounce = undefined;
      try {
        transcriptTail.stop();
      } catch {
      }
    },
  };
}
