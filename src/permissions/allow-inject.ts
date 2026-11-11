export interface PtyWriter {
  write(data: string): void;
}

export const KEYSTROKE_YES = "1\r";
export const KEYSTROKE_NO = "No";

export const DEFAULT_INJECT_TIMEOUT_MS = 2000;

export const DEFAULT_INJECT_POLL_MS = 50;

export function keystrokeFor(decision: "allow" | "deny"): string {
  return decision === "allow" ? KEYSTROKE_YES : KEYSTROKE_NO;
}

export type Schedule = (fn: () => void, ms: number) => void;

const defaultSchedule: Schedule = (fn, ms) => {
  setTimeout(fn, ms);
};

export type InjectResult =
  | { status: "cleared"; keystroke: string }
  | { status: "suppressed" }
  | { status: "stuck"; keystroke: string };

export interface ClearNativePromptOptions {
  pty: PtyWriter;
  decision: "allow" | "deny";
  isPromptShown: () => boolean;
  timeoutMs?: number;
  pollMs?: number;
  schedule?: Schedule;
  onWarn?: (message: string) => void;
}

export function clearNativePrompt(opts: ClearNativePromptOptions): Promise<InjectResult> {
  const {
    pty,
    decision,
    isPromptShown,
    timeoutMs = DEFAULT_INJECT_TIMEOUT_MS,
    pollMs = DEFAULT_INJECT_POLL_MS,
    schedule = defaultSchedule,
    onWarn,
  } = opts;

  return new Promise<InjectResult>((resolve) => {
    if (!isPromptShown()) {
      resolve({ status: "suppressed" });
      return;
    }

    const keystroke = keystrokeFor(decision);
    pty.write(keystroke);

    const deadline = timeoutMs;
    let elapsed = 0;
    const poll = (): void => {
      if (!isPromptShown()) {
        resolve({ status: "cleared", keystroke });
        return;
      }
      elapsed += pollMs;
      if (elapsed >= deadline) {
        onWarn?.(
          `[gate §9] STUCK PROMPT: injected "${JSON.stringify(keystroke)}" but the native TUI ` +
            `permission prompt did not clear within ${timeoutMs}ms (#52822). NOT approving silently — ` +
            `holding for manual resolution.`,
        );
        resolve({ status: "stuck", keystroke });
        return;
      }
      schedule(poll, pollMs);
    };
    schedule(poll, pollMs);
  });
}
