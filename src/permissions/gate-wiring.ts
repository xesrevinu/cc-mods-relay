import * as os from "node:os";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { findFreePort } from "../gate/port.js";
import { injectHook, restore, type Backup } from "../gate/settings-writer.js";
import {
  startHookServer,
  type ForwardedToolCall,
  type HookServer,
  type ToolDecision,
} from "./hook-server.js";
import { askUserQuestionDenyReason, isAskUserQuestionTool } from "./deny.js";
import {
  requestPermission,
  ToolUseCorrelator,
  type PermissionClient,
} from "./request-permission.js";
import {
  buildElicitationRequest,
  mapOutcomeToDecision,
  requestElicitation,
  type AskUserQuestionInput,
  type ElicitationClient,
} from "./elicitation-bridge.js";
import { clearNativePrompt, type PtyWriter, type Schedule } from "./allow-inject.js";

export const NATIVE_PERMISSION_PROMPT_MARKERS: readonly string[] = [
  "Do you want to proceed",
  "Do you want to allow",
  "Yes, and don't ask again",
  "Yes, allow",
  "1. Yes",
  "No, and tell Claude",
];

export const SUBAGENT_PROMPT_MARKER = "Tool use · from the";

function stripAnsiText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

export function textShowsNativePrompt(text: string): boolean {
  const stripped = stripAnsiText(text);
  return (
    NATIVE_PERMISSION_PROMPT_MARKERS.some((m) => stripped.includes(m)) ||
    stripped.includes(SUBAGENT_PROMPT_MARKER)
  );
}

export const DEFAULT_CORRELATION_WAIT_MS = 5000;
export const DEFAULT_CORRELATION_POLL_MS = 50;
export const DEFAULT_CORRELATION_RENUDGE_MS = 250;

export const DEFAULT_PERMISSION_HEARTBEAT_MS = 30_000;
export const DEFAULT_PROMPT_APPEAR_MS = 1500;
export const DEFAULT_PROMPT_POLL_MS = 100;
export const DEFAULT_INJECT_TIMEOUT_MS = 2000;
export const DEFAULT_CLOSE_TIMEOUT_MS = 2000;
const OUTPUT_TAIL_CAP = 16384;

export const SCRATCH_SETTINGS_PREFIX = "fork-acp-gate-settings-";

const EDIT_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export interface GatePty extends PtyWriter {
  onData?(cb: (data: string) => void): { dispose(): void };
}

export const DEFAULT_ELICITATION_TIMEOUT_MS = 300_000;

export interface SessionGateOptions {
  client: PermissionClient & ElicitationClient;
  onWarn?: (message: string) => void;
  clientSupportsElicitationForm?: boolean;
  elicitationTimeoutMs?: number;
  schedule?: Schedule;
  settingsDir?: string;
  hookTimeoutSeconds?: number;
  deciderTimeoutMs?: number;
  correlationWaitMs?: number;
  correlationPollMs?: number;
  correlationRenudgeMs?: number;
  promptAppearMs?: number;
  promptPollMs?: number;
  injectTimeoutMs?: number;
  closeTimeoutMs?: number;
  findPort?: () => Promise<number>;
}

export interface SubagentRelay {
  parentId: string | null;
  subagentLabel: string;
}
export type ResolveSubagentRelay = (innerToolUseId: string) => SubagentRelay | undefined;

export interface SessionGate {
  port: number;
  readonly token: string;
  settingsPath: string;
  correlator: ToolUseCorrelator;
  bindSession(
    sessionId: string,
    nudge?: () => void,
    resolveSubagentRelay?: ResolveSubagentRelay,
    noteActivity?: () => void,
  ): void;
  bindPty(pty: GatePty): void;
  teardown(): Promise<void>;
  readonly isTorndown: boolean;
}

const defaultSchedule: Schedule = (fn, ms) => {
  setTimeout(fn, ms);
};

function isAskUserQuestionInput(input: unknown): input is AskUserQuestionInput {
  if (
    typeof input !== "object" ||
    input === null ||
    !("questions" in input) ||
    !Array.isArray((input as { questions: unknown }).questions)
  ) {
    return false;
  }
  const questions = (input as { questions: unknown[] }).questions;
  if (questions.length === 0) return false;
  return questions.every((q) => {
    if (typeof q !== "object" || q === null) return false;
    const question = q as { header?: unknown; options?: unknown };
    if (typeof question.header !== "string") return false;
    if (!Array.isArray(question.options) || question.options.length === 0) return false;
    return question.options.every(
      (o) =>
        typeof o === "object" && o !== null && typeof (o as { label?: unknown }).label === "string",
    );
  });
}

class SessionGateImpl implements SessionGate {
  port = 0;
  token = "";
  settingsPath = "";
  readonly correlator = new ToolUseCorrelator();

  private server?: HookServer;
  private backup?: Backup;
  private sessionId?: string;
  private nudge?: () => void;
  private resolveSubagentRelay?: ResolveSubagentRelay;
  private noteActivity?: () => void;
  private pty?: PtyWriter;
  private outputTap?: { dispose(): void };
  private outputTail = "";
  private totalOutput = 0;
  private torndown = false;
  private permissionQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: SessionGateOptions) {}

  get isTorndown(): boolean {
    return this.torndown;
  }

  private warn(message: string): void {
    this.opts.onWarn?.(message);
  }

  private get schedule(): Schedule {
    return this.opts.schedule ?? defaultSchedule;
  }

  private enqueuePermission<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.permissionQueue.then(fn, fn);
    this.permissionQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private startPermissionHeartbeat(): () => void {
    const note = this.noteActivity;
    if (!note) return () => {};
    let stopped = false;
    const tick = (): void => {
      if (stopped || this.torndown) return;
      try {
        note();
      } catch {
      }
      this.schedule(tick, DEFAULT_PERMISSION_HEARTBEAT_MS);
    };
    this.schedule(tick, DEFAULT_PERMISSION_HEARTBEAT_MS);
    return () => {
      stopped = true;
    };
  }

  async start(): Promise<void> {
    const findPort = this.opts.findPort ?? findFreePort;
    this.port = await findPort();

    this.token = randomBytes(24).toString("hex");

    this.server = await startHookServer({
      port: this.port,
      token: this.token,
      deciderTimeoutMs: this.opts.deciderTimeoutMs,
      onWarn: (m) => this.warn(m),
      onToolCall: (call) => this.decide(call),
    });

    const dir = this.opts.settingsDir ?? os.tmpdir();
    this.settingsPath = path.join(dir, `${SCRATCH_SETTINGS_PREFIX}${randomUUID()}.json`);
    try {
      this.backup = await injectHook({
        settingsPath: this.settingsPath,
        port: this.port,
        token: this.token,
        timeout: this.opts.hookTimeoutSeconds,
      });
    } catch (err) {
      await this.closeServerBounded();
      throw err;
    }
  }

  bindSession(
    sessionId: string,
    nudge?: () => void,
    resolveSubagentRelay?: ResolveSubagentRelay,
    noteActivity?: () => void,
  ): void {
    this.sessionId = sessionId;
    this.nudge = nudge;
    this.resolveSubagentRelay = resolveSubagentRelay;
    this.noteActivity = noteActivity;
  }

  bindPty(pty: GatePty): void {
    this.pty = pty;
    if (typeof pty.onData === "function") {
      this.outputTap = pty.onData((data: string) => {
        this.totalOutput += data.length;
        this.outputTail = (this.outputTail + data).slice(-OUTPUT_TAIL_CAP);
      });
    }
  }

  private outputSince(mark: number): string {
    const available = Math.min(this.outputTail.length, Math.max(0, this.totalOutput - mark));
    return available === 0 ? "" : this.outputTail.slice(-available);
  }

  private async decide(call: ForwardedToolCall): Promise<ToolDecision> {
    if (this.torndown) return "deny";

    if (isAskUserQuestionTool(call.toolName)) {
      if (this.opts.clientSupportsElicitationForm) {
        return await this.decideElicitation(call);
      }
      return { decision: "deny", reason: askUserQuestionDenyReason() };
    }

    if (call.permissionMode === "bypassPermissions") return "allow";
    if (call.permissionMode === "acceptEdits" && EDIT_TOOLS.has(call.toolName)) return "allow";

    try {
      this.nudge?.();
    } catch {
    }

    const sessionId = this.sessionId ?? call.sessionId;
    if (!sessionId) {
      this.warn(
        `[gate §9] FAIL CLOSED: PreToolUse for tool_use ${call.toolUseId} arrived before the gate ` +
          `was bound to an ACP session — denying (cannot raise session/request_permission).`,
      );
      return "deny";
    }

    this.correlator.ensureRegistered(call.toolUseId);

    await this.waitForCorrelation(call.toolUseId);

    let subagentLabel: string | undefined = call.agentType;
    let relay = this.resolveSubagentRelay?.(call.toolUseId);
    if (!relay && call.agentType !== undefined) {
      relay = await this.waitForSubagentParent(call.toolUseId);
    }
    let dialogToolCallId: string | undefined;
    if (relay) {
      subagentLabel = call.agentType ?? relay.subagentLabel;
      if (relay.parentId !== null) {
        dialogToolCallId = relay.parentId;
      }
    }

    return this.enqueuePermission(async () => {
      const stopHeartbeat = this.startPermissionHeartbeat();
      try {
        const decision = await requestPermission({
          client: this.opts.client,
          sessionId,
          toolCall: {
            toolUseId: call.toolUseId,
            toolName: call.toolName,
            toolInput: call.toolInput,
          },
          correlator: this.correlator,
          onWarn: (m) => this.warn(m),
          dialogToolCallId,
          subagentLabel,
        });

        if (decision === "allow") {
          this.armAllowSweep(call);
        }
        return decision;
      } finally {
        stopHeartbeat();
      }
    });
  }

  private async decideElicitation(call: ForwardedToolCall): Promise<ToolDecision> {
    const sessionId = this.sessionId ?? call.sessionId;
    if (!sessionId) {
      this.warn(
        `[gate elicitation] FAIL CLOSED: AskUserQuestion for tool_use ${call.toolUseId} arrived before ` +
          `the gate was bound to an ACP session — cannot raise a session-scoped elicitation; denying ` +
          `(story-064 fallback).`,
      );
      return { decision: "deny", reason: askUserQuestionDenyReason() };
    }

    if (!isAskUserQuestionInput(call.toolInput)) {
      this.warn(
        `[gate elicitation] FAIL CLOSED: AskUserQuestion tool_use ${call.toolUseId} carried a malformed ` +
          `tool_input (expected an object with a non-empty "questions" array) — cannot build a form ` +
          `elicitation; denying (story-064 fallback).`,
      );
      return { decision: "deny", reason: askUserQuestionDenyReason() };
    }

    const stopHeartbeat = this.startPermissionHeartbeat();
    try {
      const req = buildElicitationRequest(call.toolUseId, sessionId, call.toolInput);
      const resp = await requestElicitation(this.opts.client, req, {
        timeoutMs: this.opts.elicitationTimeoutMs ?? DEFAULT_ELICITATION_TIMEOUT_MS,
        onWarn: (m) => this.warn(m),
      });
      return mapOutcomeToDecision(resp);
    } catch (err) {
      this.warn(
        `[gate elicitation] FAIL CLOSED: AskUserQuestion tool_use ${call.toolUseId} could not be ` +
          `elicited (${err instanceof Error ? err.message : String(err)}) — denying (story-064 ` +
          `fallback); the tool is intercepted, never approved.`,
      );
      return { decision: "deny", reason: askUserQuestionDenyReason() };
    } finally {
      stopHeartbeat();
    }
  }

  private waitForCorrelation(toolUseId: string): Promise<void> {
    const waitMs = this.opts.correlationWaitMs ?? DEFAULT_CORRELATION_WAIT_MS;
    const pollMs = this.opts.correlationPollMs ?? DEFAULT_CORRELATION_POLL_MS;
    const renudgeMs = this.opts.correlationRenudgeMs ?? DEFAULT_CORRELATION_RENUDGE_MS;
    if (this.correlator.isCleanMatch(toolUseId)) return Promise.resolve();
    return new Promise((resolve) => {
      let elapsed = 0;
      let sinceNudge = 0;
      const poll = (): void => {
        if (this.torndown || this.correlator.isCleanMatch(toolUseId)) {
          resolve();
          return;
        }
        elapsed += pollMs;
        sinceNudge += pollMs;
        if (sinceNudge >= renudgeMs) {
          sinceNudge = 0;
          try {
            this.nudge?.();
          } catch {
          }
        }
        if (elapsed >= waitMs) {
          this.warn(
            `[gate §9] correlation wait expired (${waitMs}ms) for tool_use ${toolUseId} — the JSONL ` +
              `tool_use line never reached the pump; the decision will fail closed (deny).`,
          );
          resolve();
          return;
        }
        this.schedule(poll, pollMs);
      };
      this.schedule(poll, pollMs);
    });
  }

  private waitForSubagentParent(innerToolUseId: string): Promise<SubagentRelay | undefined> {
    const resolveNow = (): SubagentRelay | undefined => this.resolveSubagentRelay?.(innerToolUseId);
    const immediate = resolveNow();
    if (immediate) return Promise.resolve(immediate);
    const waitMs = this.opts.correlationWaitMs ?? DEFAULT_CORRELATION_WAIT_MS;
    const pollMs = this.opts.correlationPollMs ?? DEFAULT_CORRELATION_POLL_MS;
    const renudgeMs = this.opts.correlationRenudgeMs ?? DEFAULT_CORRELATION_RENUDGE_MS;
    return new Promise((resolve) => {
      let elapsed = 0;
      let sinceNudge = 0;
      const poll = (): void => {
        if (this.torndown) {
          resolve(undefined);
          return;
        }
        const r = resolveNow();
        if (r) {
          resolve(r);
          return;
        }
        elapsed += pollMs;
        sinceNudge += pollMs;
        if (sinceNudge >= renudgeMs) {
          sinceNudge = 0;
          try {
            this.nudge?.();
          } catch {
          }
        }
        if (elapsed >= waitMs) {
          resolve(undefined);
          return;
        }
        this.schedule(poll, pollMs);
      };
      this.schedule(poll, pollMs);
    });
  }

  private armAllowSweep(call: ForwardedToolCall): void {
    const pty = this.pty;
    if (!pty) {
      this.warn(
        `[gate §9] allow for tool_use ${call.toolUseId}: no PTY bound — cannot run the #52822 ` +
          `keystroke sweep; if the native prompt appears it needs a manual keystroke.`,
      );
      return;
    }
    const appearMs = this.opts.promptAppearMs ?? DEFAULT_PROMPT_APPEAR_MS;
    const pollMs = this.opts.promptPollMs ?? DEFAULT_PROMPT_POLL_MS;
    const appearMark = this.totalOutput;

    let elapsed = 0;
    const pollAppear = (): void => {
      if (this.torndown) return;
      if (textShowsNativePrompt(this.outputSince(appearMark))) {
        void this.runClear(call, pty);
        return;
      }
      elapsed += pollMs;
      if (elapsed >= appearMs) return;
      this.schedule(pollAppear, pollMs);
    };
    this.schedule(pollAppear, pollMs);
  }

  private async runClear(call: ForwardedToolCall, pty: PtyWriter): Promise<void> {
    let keystrokeMark: number | null = null;
    const isPromptShown = (): boolean => {
      if (keystrokeMark === null) {
        keystrokeMark = this.totalOutput;
        return true;
      }
      if (this.totalOutput === keystrokeMark) return true;
      return textShowsNativePrompt(this.outputSince(keystrokeMark));
    };

    const result = await clearNativePrompt({
      pty,
      decision: "allow",
      isPromptShown,
      timeoutMs: this.opts.injectTimeoutMs ?? DEFAULT_INJECT_TIMEOUT_MS,
      pollMs: this.opts.promptPollMs ?? DEFAULT_PROMPT_POLL_MS,
      schedule: this.schedule,
      onWarn: (m) => this.warn(m),
    });
    if (result.status === "stuck") {
      this.warn(
        `[gate §9] STUCK PROMPT for tool_use ${call.toolUseId} (tool "${call.toolName}") — the ` +
          `allow keystroke did not clear the native prompt; holding (no silent approve).`,
      );
    }
  }

  private async closeServerBounded(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    const closeTimeoutMs = this.opts.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    let timedOut = false;
    await Promise.race([
      server.close(),
      new Promise<void>((resolve) =>
        this.schedule(() => {
          timedOut = true;
          resolve();
        }, closeTimeoutMs),
      ),
    ]);
    if (timedOut) {
      this.warn(
        `[gate §9] hook server on 127.0.0.1:${this.port} did not close within ${closeTimeoutMs}ms ` +
          `(an in-flight decider may be holding a request open); teardown proceeds — the close ` +
          `completes in the background.`,
      );
    }
  }

  async teardown(): Promise<void> {
    if (this.torndown) return;
    this.torndown = true;

    this.outputTap?.dispose();
    this.outputTap = undefined;

    await this.closeServerBounded();

    const backup = this.backup;
    this.backup = undefined;
    if (backup) {
      try {
        await restore(backup);
      } catch (err) {
        this.warn(
          `[gate §9] scratch settings restore failed for ${backup.settingsPath} ` +
            `(${err instanceof Error ? err.message : String(err)}) — the file may need manual removal.`,
        );
      }
    }
  }
}

export async function setupSessionGate(opts: SessionGateOptions): Promise<SessionGate> {
  const gate = new SessionGateImpl(opts);
  await gate.start();
  return gate;
}
