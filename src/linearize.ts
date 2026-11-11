import type { SessionMessage, GetMessages } from "./engine-watcher.js";

export interface Turn {
  orderKey: string;
  uuid: string;
  parentUuid: string | null;
  role: string;
  message: SessionMessage;
  sidechain?: { parentToolUseId: string };
  nested?: SessionMessage[];
}

export type SidechainPolicy = "nested" | "hidden" | "inline";

export interface LinearizeOptions extends ApplyPolicyOptions {
  sidechainPolicy?: SidechainPolicy;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parentToolUseIdOf(m: SessionMessage): string | undefined {
  const rec = m as Record<string, unknown>;
  const v = rec.parent_tool_use_id ?? rec.parentToolUseId;
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function isSidechainMsg(m: SessionMessage): boolean {
  const rec = m as Record<string, unknown>;
  if (typeof rec.isSidechain === "boolean") return rec.isSidechain;
  return parentToolUseIdOf(m) !== undefined;
}

function isMetaMsg(m: SessionMessage): boolean {
  const rec = m as Record<string, unknown>;
  if (rec.isMeta === true) return true;
  if (isReplayHiddenMetaMessage(m)) return true;
  return m.type === "summary" || m.type === "system";
}

const REPLAY_HIDDEN_META_ORIGIN_KINDS = new Set([
  "peer",
  "channel",
  "observer",
  "observer-activity",
  "slack-ping",
]);

export function isReplayHiddenMetaMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const { type, is_meta, origin } = message as {
    type?: unknown;
    is_meta?: unknown;
    origin?: { kind?: unknown } | null;
  };
  return (
    type === "user" &&
    is_meta === true &&
    typeof origin?.kind === "string" &&
    REPLAY_HIDDEN_META_ORIGIN_KINDS.has(origin.kind)
  );
}

function parentUuidOf(m: SessionMessage): string | null {
  const rec = m as Record<string, unknown>;
  return typeof rec.parentUuid === "string" ? rec.parentUuid : null;
}

function uuidOf(m: SessionMessage): string {
  return typeof m.uuid === "string" ? m.uuid : "";
}

export function chainPositionKey(uuid: string, index: number): string {
  return `${String(index).padStart(8, "0")}:${uuid}`;
}

function toolUseIdsOf(m: SessionMessage): string[] {
  const message = (m as Record<string, unknown>).message;
  if (!isObject(message)) return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (isObject(block) && block.type === "tool_use" && typeof block.id === "string") {
      ids.push(block.id);
    }
  }
  return ids;
}

function collectToolUseIds(mainMessages: SessionMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of mainMessages) {
    for (const id of toolUseIdsOf(m)) ids.add(id);
  }
  return ids;
}

export interface SidechainDriftRecord {
  kind: "orphan-sidechain";
  parentToolUseId: string | null;
  uuid: string;
}

function defaultSidechainDrift(record: SidechainDriftRecord): void {
  console.error(`[lin-drift] ${JSON.stringify(record)}`);
}

export interface ApplyPolicyOptions {
  onDrift?: (record: SidechainDriftRecord) => void;
}

export interface AppliedPolicy {
  topLevel: SessionMessage[];
  nestedByToolUseId?: Map<string, SessionMessage[]>;
}

export function applySidechainPolicy(
  messages: SessionMessage[],
  policy: SidechainPolicy,
  opts: ApplyPolicyOptions = {},
): AppliedPolicy {
  const onDrift = opts.onDrift ?? defaultSidechainDrift;

  const nonMeta: SessionMessage[] = [];
  const main: SessionMessage[] = [];
  const sidechain: SessionMessage[] = [];
  for (const m of messages) {
    if (!isObject(m) || isMetaMsg(m)) continue;
    nonMeta.push(m);
    if (isSidechainMsg(m)) sidechain.push(m);
    else main.push(m);
  }

  if (policy === "hidden") {
    return { topLevel: main };
  }
  if (policy === "inline") {
    return { topLevel: nonMeta };
  }

  const validToolUseIds = collectToolUseIds(main);
  const nestedByToolUseId = new Map<string, SessionMessage[]>();
  const orphans = new Set<SessionMessage>();
  for (const s of sidechain) {
    const pid = parentToolUseIdOf(s);
    if (pid !== undefined && validToolUseIds.has(pid)) {
      const arr = nestedByToolUseId.get(pid) ?? [];
      arr.push(s);
      nestedByToolUseId.set(pid, arr);
    } else {
      orphans.add(s);
      onDrift({ kind: "orphan-sidechain", parentToolUseId: pid ?? null, uuid: uuidOf(s) });
    }
  }

  const topLevel: SessionMessage[] = [];
  for (const m of nonMeta) {
    if (isSidechainMsg(m)) {
      if (orphans.has(m)) topLevel.push(m);
    } else {
      topLevel.push(m);
    }
  }
  return { topLevel, nestedByToolUseId };
}

export function linearizeTurns(messages: SessionMessage[], opts: LinearizeOptions = {}): Turn[] {
  const policy = opts.sidechainPolicy ?? "nested";
  const { topLevel, nestedByToolUseId } = applySidechainPolicy(messages, policy, {
    onDrift: opts.onDrift,
  });

  return topLevel.map((m, index) => {
    const turn: Turn = {
      orderKey: chainPositionKey(uuidOf(m), index),
      uuid: uuidOf(m),
      parentUuid: parentUuidOf(m),
      role: typeof m.type === "string" ? m.type : "",
      message: m,
    };
    if (isSidechainMsg(m)) {
      const pid = parentToolUseIdOf(m);
      if (pid !== undefined) turn.sidechain = { parentToolUseId: pid };
    } else if (policy === "nested" && nestedByToolUseId) {
      const children: SessionMessage[] = [];
      for (const id of toolUseIdsOf(m)) {
        const group = nestedByToolUseId.get(id);
        if (group) children.push(...group);
      }
      if (children.length > 0) {
        children.sort((x, y) => uuidOf(x).localeCompare(uuidOf(y)));
        turn.nested = children;
      }
    }
    return turn;
  });
}

export async function readOrderedMessages(
  sessionId: string,
  dir: string | undefined,
  opts: { getMessages?: GetMessages } = {},
): Promise<SessionMessage[]> {
  const getMessages = opts.getMessages ?? defaultGetMessages;
  try {
    return await getMessages(sessionId, { dir });
  } catch (err) {
    throw new Error(
      `getSessionMessages failed for sessionId="${sessionId}" dir="${dir ?? "<none>"}": ${String(err)}`,
      { cause: err },
    );
  }
}

export async function defaultGetMessages(
  sessionId: string,
  opts?: { dir?: string },
): Promise<SessionMessage[]> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return sdk.getSessionMessages(sessionId, opts) as Promise<SessionMessage[]>;
}

export interface FallbackOptions {
  enabled?: boolean;
}

type RawRecord = {
  uuid?: unknown;
  parentUuid?: unknown;
  type?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  message?: unknown;
  [k: string]: unknown;
};

const MAIN_ROLES: ReadonlySet<string> = new Set(["user", "assistant"]);

export function buildChainEquivalent(
  rawLines: string[],
  opts: FallbackOptions = {},
): SessionMessage[] {
  if (opts.enabled !== true) {
    throw new Error(
      "buildChainEquivalent is the R1.3 contingency and is DISABLED by default; " +
        "pass { enabled: true } to engage it. The v1 path is getSessionMessages (E5 REUSE-live).",
    );
  }

  const records: RawRecord[] = [];
  for (const line of rawLines) {
    if (typeof line !== "string" || line.length === 0) continue;
    try {
      const rec = JSON.parse(line) as unknown;
      if (isObject(rec)) records.push(rec as RawRecord);
    } catch {
      continue;
    }
  }

  const main = records.filter((r) => {
    if (r.isMeta === true || r.isSidechain === true) return false;
    return typeof r.type === "string" && MAIN_ROLES.has(r.type);
  });
  if (main.length === 0) return [];

  const byUuid = new Map<string, RawRecord>();
  for (const r of main) {
    if (typeof r.uuid === "string") byUuid.set(r.uuid, r);
  }
  const tip = main[main.length - 1];
  const reverseChain: RawRecord[] = [];
  const guard = new Set<string>();
  let cursor: RawRecord | undefined = tip;
  while (cursor) {
    const uuid = typeof cursor.uuid === "string" ? cursor.uuid : "";
    if (uuid && guard.has(uuid)) break;
    if (uuid) guard.add(uuid);
    reverseChain.push(cursor);
    const parent: string | null = typeof cursor.parentUuid === "string" ? cursor.parentUuid : null;
    cursor = parent ? byUuid.get(parent) : undefined;
  }
  reverseChain.reverse();

  return reverseChain.map((r) => ({
    type: typeof r.type === "string" ? r.type : "",
    uuid: typeof r.uuid === "string" ? r.uuid : "",
    session_id: typeof r.sessionId === "string" ? r.sessionId : "",
    message: r.message,
    parent_tool_use_id:
      typeof r.parentToolUseId === "string"
        ? r.parentToolUseId
        : typeof r.parent_tool_use_id === "string"
          ? r.parent_tool_use_id
          : null,
  }));
}

export interface ReadOrderedTurnsOptions extends LinearizeOptions {
  getMessages?: GetMessages;
}

export async function readOrderedTurns(
  sessionId: string,
  dir: string | undefined,
  opts: ReadOrderedTurnsOptions = {},
): Promise<Turn[]> {
  const messages = await readOrderedMessages(sessionId, dir, { getMessages: opts.getMessages });
  return linearizeTurns(messages, {
    sidechainPolicy: opts.sidechainPolicy,
    onDrift: opts.onDrift,
  });
}

export const TURN_WATCHDOG_MS = 5583;

function defaultSchedule(fn: () => void, ms: number): () => void {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
}

export interface BindEndOfTurnOptions {
  reparse: () => void | Promise<void>;
  watchdogMs?: number;
  schedule?: (fn: () => void, ms: number) => () => void;
}

export interface EndOfTurnBinding {
  notifyEndOfTurn(): void;
  stop(): void;
}

export function bindEndOfTurnReparse(opts: BindEndOfTurnOptions): EndOfTurnBinding {
  const watchdogMs = opts.watchdogMs ?? TURN_WATCHDOG_MS;
  const schedule = opts.schedule ?? defaultSchedule;
  let stopped = false;
  let cancelWatchdog: (() => void) | undefined;

  const armWatchdog = (): void => {
    cancelWatchdog?.();
    cancelWatchdog = schedule(() => {
      cancelWatchdog = undefined;
      if (stopped) return;
      void opts.reparse();
      armWatchdog();
    }, watchdogMs);
  };

  armWatchdog();

  return {
    notifyEndOfTurn(): void {
      if (stopped) return;
      cancelWatchdog?.();
      cancelWatchdog = undefined;
      void opts.reparse();
      armWatchdog();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      cancelWatchdog?.();
      cancelWatchdog = undefined;
    },
  };
}
