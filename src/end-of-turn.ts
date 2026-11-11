import type { PromptResponse } from "@agentclientprotocol/sdk/unstable";
import { TURN_WATCHDOG_MS } from "./linearize.js";
import { FILE_DISCOVERY_WATCHDOG_MS } from "./jsonl.js";
import { mapStopReason, type StopReasonLogger } from "./stop-reason-map.js";

export { TURN_WATCHDOG_MS, FILE_DISCOVERY_WATCHDOG_MS };

export const TURN_STALL_WATCHDOG_MS = 120_000;

export const TURN_WATCHDOG_ENV = "FORK_TURN_WATCHDOG_MS";

function resolveDefaultWatchdogMs(): number {
  const raw = process.env[TURN_WATCHDOG_ENV];
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return TURN_STALL_WATCHDOG_MS;
}

export const TERMINAL_STOP_REASONS: ReadonlySet<string> = new Set([
  "end_turn",
  "stop_sequence",
  "max_tokens",
]);

export interface StopReasonEvent {
  readonly type?: unknown;
  readonly message?: unknown;
  readonly parent_tool_use_id?: unknown;
  readonly parentToolUseId?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSidechain(event: StopReasonEvent): boolean {
  if (!isObject(event)) return false;
  const pid = event.parent_tool_use_id ?? event.parentToolUseId;
  return pid !== null && pid !== undefined;
}

const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(["Task", "Agent"]);

function contentBlocksOf(event: StopReasonEvent): readonly unknown[] {
  const message = (event as { message?: unknown }).message;
  if (!isObject(message)) return [];
  const content = message.content;
  return Array.isArray(content) ? content : [];
}

function subagentToolUseIds(event: StopReasonEvent): string[] {
  if (!isObject(event) || event.type !== "assistant") return [];
  const ids: string[] = [];
  for (const block of contentBlocksOf(event)) {
    if (
      isObject(block) &&
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string" &&
      SUBAGENT_TOOL_NAMES.has(block.name)
    ) {
      ids.push(block.id);
    }
  }
  return ids;
}

function closedToolUseIds(event: StopReasonEvent): string[] {
  const ids: string[] = [];
  for (const block of contentBlocksOf(event)) {
    if (isObject(block) && block.type === "tool_result" && typeof block.tool_use_id === "string") {
      ids.push(block.tool_use_id);
    }
  }
  return ids;
}

export function isTerminalStop(event: StopReasonEvent | null | undefined): boolean {
  if (!isObject(event)) return false;
  if (event.type !== "assistant") return false;
  if (isSidechain(event)) return false;
  const message = event.message;
  if (!isObject(message)) return false;
  const stopReason = message.stop_reason;
  return typeof stopReason === "string" && TERMINAL_STOP_REASONS.has(stopReason);
}

export function findTerminalCandidate<E extends StopReasonEvent>(
  events: readonly E[],
): E | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (isTerminalStop(events[i])) return events[i];
  }
  return undefined;
}

export const DELTA_T_MS = 200;

export type DetectorSchedule = (fn: () => void, ms: number) => () => void;

const defaultSchedule: DetectorSchedule = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  (handle as { unref?: () => void }).unref?.();
  return () => clearTimeout(handle);
};

export interface TurnTimeoutDiagnostics {
  readonly elapsedMs: number;
  readonly lastEventType?: string;
  readonly lastStopReason?: string;
  readonly sessionId?: string;
}

export class TurnTimeoutError extends Error {
  readonly elapsedMs: number;
  readonly lastEventType?: string;
  readonly lastStopReason?: string;
  readonly sessionId?: string;
  constructor(diag: TurnTimeoutDiagnostics) {
    super(
      `end-of-turn not detected within ${diag.elapsedMs}ms turn watchdog` +
        (diag.sessionId ? ` (session ${diag.sessionId})` : "") +
        (diag.lastEventType
          ? `; last event type=${diag.lastEventType} stop_reason=${diag.lastStopReason ?? "null"}`
          : ""),
    );
    this.name = "TurnTimeoutError";
    this.elapsedMs = diag.elapsedMs;
    this.lastEventType = diag.lastEventType;
    this.lastStopReason = diag.lastStopReason;
    this.sessionId = diag.sessionId;
  }
}

export interface EndOfTurnDetectorOptions {
  onEndOfTurn: (boundary: StopReasonEvent) => void;
  onTurnTimeout?: (error: TurnTimeoutError) => void;
  schedule?: DetectorSchedule;
  deltaTMs?: number;
  watchdogMs?: number;
  sessionId?: string;
  logger?: { error: (...args: unknown[]) => void };
}

export interface EndOfTurnDetector {
  beginTurn(): void;
  observe(event: StopReasonEvent): void;
  noteActivity(): void;
  markCancelled(): void;
  stop(): void;
  /** Mods `turn.complete` — settle now, without waiting for a JSONL stop_reason. */
  finish(stopReason?: string): void;
}

function eventUuid(event: StopReasonEvent): string | undefined {
  const uuid = (event as { uuid?: unknown }).uuid;
  return typeof uuid === "string" && uuid.length > 0 ? uuid : undefined;
}

function isUserOrAssistantWrite(event: StopReasonEvent): boolean {
  return isObject(event) && (event.type === "user" || event.type === "assistant");
}

function eventDiag(event: StopReasonEvent | undefined): {
  lastEventType?: string;
  lastStopReason?: string;
} {
  if (!isObject(event)) return {};
  const lastEventType = typeof event.type === "string" ? event.type : undefined;
  const message = event.message;
  const lastStopReason =
    isObject(message) && typeof message.stop_reason === "string" ? message.stop_reason : undefined;
  return { lastEventType, lastStopReason };
}

export function createEndOfTurnDetector(opts: EndOfTurnDetectorOptions): EndOfTurnDetector {
  const schedule = opts.schedule ?? defaultSchedule;
  const deltaTMs = opts.deltaTMs ?? DELTA_T_MS;
  const watchdogMs = opts.watchdogMs ?? resolveDefaultWatchdogMs();

  let pendingCandidate: StopReasonEvent | undefined;
  let cancelDelta: (() => void) | undefined;
  let cancelWatchdog: (() => void) | undefined;
  let lastEvent: StopReasonEvent | undefined;
  const firedUuids = new Set<string>();
  const openTaskIds = new Set<string>();
  let stopped = false;
  let cancelled = false;

  function clearDelta(): void {
    cancelDelta?.();
    cancelDelta = undefined;
  }

  function clearWatchdog(): void {
    cancelWatchdog?.();
    cancelWatchdog = undefined;
  }

  function confirmBoundary(): void {
    if (cancelled) return;
    const boundary = pendingCandidate;
    if (!boundary) return;
    pendingCandidate = undefined;
    clearDelta();
    clearWatchdog();
    openTaskIds.clear();
    const uuid = eventUuid(boundary);
    if (uuid) firedUuids.add(uuid);
    opts.onEndOfTurn(boundary);
  }

  function armDelta(): void {
    clearDelta();
    cancelDelta = schedule(() => {
      cancelDelta = undefined;
      confirmBoundary();
    }, deltaTMs);
  }

  function armWatchdog(): void {
    clearWatchdog();
    cancelWatchdog = schedule(() => {
      cancelWatchdog = undefined;
      if (openTaskIds.size > 0) {
        armWatchdog();
        return;
      }
      const error = new TurnTimeoutError({
        elapsedMs: watchdogMs,
        sessionId: opts.sessionId,
        ...eventDiag(lastEvent),
      });
      opts.logger?.error("[end-of-turn] turn watchdog tripped:", error.message);
      opts.onTurnTimeout?.(error);
    }, watchdogMs);
  }

  return {
    beginTurn(): void {
      if (stopped || cancelled) return;
      armWatchdog();
    },
    observe(event: StopReasonEvent): void {
      if (stopped || cancelled) return;
      lastEvent = event;
      for (const id of closedToolUseIds(event)) openTaskIds.delete(id);
      for (const id of subagentToolUseIds(event)) openTaskIds.add(id);
      if (cancelWatchdog !== undefined) armWatchdog();
      if (pendingCandidate && event !== pendingCandidate && isUserOrAssistantWrite(event)) {
        confirmBoundary();
      }
      if (isTerminalStop(event)) {
        const uuid = eventUuid(event);
        if (uuid && firedUuids.has(uuid)) return;
        pendingCandidate = event;
        armDelta();
      }
    },
    noteActivity(): void {
      if (stopped || cancelled) return;
      if (cancelWatchdog !== undefined) armWatchdog();
    },
    markCancelled(): void {
      cancelled = true;
      clearDelta();
      clearWatchdog();
      pendingCandidate = undefined;
      openTaskIds.clear();
    },
    stop(): void {
      stopped = true;
      clearDelta();
      clearWatchdog();
      pendingCandidate = undefined;
      openTaskIds.clear();
    },
    finish(stopReason = "end_turn"): void {
      if (stopped || cancelled) return;
      pendingCandidate = { type: "assistant", message: { stop_reason: stopReason } };
      confirmBoundary();
    },
  };
}

function readStopReason(event: StopReasonEvent): unknown {
  const message = (event as { message?: unknown }).message;
  return isObject(message) ? message.stop_reason : undefined;
}

export interface TurnResolverOptions {
  schedule?: DetectorSchedule;
  sessionId?: string;
  logger?: StopReasonLogger;
  deltaTMs?: number;
  watchdogMs?: number;
  onTurnResolved?: () => void;
}

export interface TurnResolver {
  detector: EndOfTurnDetector;
  promise: Promise<PromptResponse>;
  cancel(): void;
}

export function createTurnResolver(opts: TurnResolverOptions = {}): TurnResolver {
  let settled = false;
  let resolveFn!: (response: PromptResponse) => void;
  let rejectFn!: (error: unknown) => void;
  const promise = new Promise<PromptResponse>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });

  function settle(action: () => void): void {
    if (settled) return;
    settled = true;
    action();
  }

  const detector = createEndOfTurnDetector({
    onEndOfTurn: (boundary) =>
      settle(() => {
        resolveFn({ stopReason: mapStopReason(readStopReason(boundary), opts.logger) });
        opts.onTurnResolved?.();
      }),
    onTurnTimeout: (error) => settle(() => rejectFn(error)),
    schedule: opts.schedule,
    sessionId: opts.sessionId,
    logger: opts.logger,
    deltaTMs: opts.deltaTMs,
    watchdogMs: opts.watchdogMs,
  });

  return {
    detector,
    promise,
    cancel(): void {
      settle(() => resolveFn({ stopReason: "cancelled" }));
      detector.markCancelled();
    },
  };
}
