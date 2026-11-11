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
  onEvent: (message: SessionMessage) => void;
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

export function createJsonlWatcher(opts: JsonlWatcherOptions): JsonlWatcher {
  const {
    sessionId,
    transcriptPath,
    dir,
    onEvent,
    getMessages,
    tail = tailTranscript,
    debounceMs = DEFAULT_WATCHER_DEBOUNCE_MS,
    schedule = defaultSchedule,
  } = opts;

  const readMessages: GetMessages = getMessages ?? defaultGetMessages;

  const seen = new Set<string>();

  let stopped = false;
  let reading = false;
  let pendingReread = false;
  let cancelDebounce: (() => void) | undefined;

  const runReread = async (): Promise<void> => {
    if (stopped) return;
    if (reading) {
      pendingReread = true;
      return;
    }
    reading = true;
    try {
      do {
        pendingReread = false;
        let messages: SessionMessage[];
        try {
          messages = await readMessages(sessionId, { dir });
        } catch {
          continue;
        }
        if (stopped) return;
        for (const message of messages) {
          const { uuid } = message;
          if (typeof uuid === "string") {
            if (seen.has(uuid)) continue;
            seen.add(uuid);
          }
          onEvent(message);
        }
      } while (pendingReread && !stopped);
    } finally {
      reading = false;
    }
  };

  const scheduleReread = (): void => {
    if (stopped) return;
    cancelDebounce?.();
    cancelDebounce = schedule(() => {
      cancelDebounce = undefined;
      void runReread();
    }, debounceMs);
  };

  const transcriptTail = tail(transcriptPath, {
    onRecord: () => scheduleReread(),
  });

  return {
    notifyEndOfTurn(): void {
      if (stopped) return;
      cancelDebounce?.();
      cancelDebounce = undefined;
      void runReread();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      cancelDebounce?.();
      cancelDebounce = undefined;
      pendingReread = false;
      try {
        transcriptTail.stop();
      } catch {
      }
    },
  };
}

async function defaultGetMessages(
  sessionId: string,
  opts?: { dir?: string },
): Promise<SessionMessage[]> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return sdk.getSessionMessages(sessionId, opts) as Promise<SessionMessage[]>;
}
