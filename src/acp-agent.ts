import {
  agent as acpAgent,
  type AgentContext,
  AuthenticateRequest,
  AuthMethod,
  CancelNotification,
  ClientCapabilities,
  ForkSessionRequest,
  ForkSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  ndJsonStream,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestError,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionModeState,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  ToolCallContent,
  CloseSessionRequest,
  CloseSessionResponse,
  DeleteSessionRequest,
  DeleteSessionResponse,
  LogoutRequest,
  LogoutResponse,
  SetSessionTitleRequest,
  SetSessionTitleResponse,
  TerminalHandle,
  TerminalOutputResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  AvailableCommand,
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  methods,
} from "@agentclientprotocol/sdk/unstable";
import {
  deleteSession,
  getSessionInfo,
  listSessions,
  renameSession,
  ModelInfo,
  Options,
  PermissionMode,
  PermissionUpdate,
  SDKMessageOrigin,
  Settings,
} from "@anthropic-ai/claude-agent-sdk";
import { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { BetaContentBlock, BetaRawContentBlockDelta } from "@anthropic-ai/sdk/resources/beta.mjs";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { SettingsManager } from "./settings.js";
import {
  applyTaskCreate,
  applyTaskUpdate,
  ClaudePlanEntry,
  parseTaskCreateOutput,
  parseTaskListOutput,
  parseTaskUpdateOutput,
  applyTaskList,
  planEntries,
  registerHookCallback,
  TaskState,
  taskStateToPlanEntries,
  toolInfoFromToolUse,
  toolUpdateFromDiffToolResponse,
  toolUpdateFromToolResult,
} from "./tools.js";
import { nodeToWebReadable, nodeToWebWritable, unreachable } from "./utils.js";
import type { EngineTerminal } from "./terminal-backend.js";
import { createSessionEngine, spawnResumePty, SessionEngine } from "./engine-lifecycle.js";
import type { SessionWatcher } from "./engine-lifecycle.js";
import { createJsonlWatcher } from "./engine-watcher.js";
import type { JsonlWatcher, GetMessages, SessionMessage } from "./engine-watcher.js";
import { findTranscript, readFileTail, resolveWatchTarget } from "./jsonl.js";
import type { LocateOptions } from "./jsonl.js";
import { linearizeTurns, readOrderedMessages, defaultGetMessages } from "./linearize.js";
import { createDiffEnrichedReader } from "./diff-enriched-reader.js";
import { backgroundTaskEnds, type BackgroundTaskEnd } from "./background-task-end.js";
import { readTranscriptPermissionMode } from "./resumed-permission-mode.js";
import type { DiffEnrichedReaderOptions } from "./diff-enriched-reader.js";
import { withPrecompactHistory, type PrecompactHistoryOptions } from "./compacted-history.js";
import {
  clientSupportsCompaction,
  compactEventFromMessage,
  compactPercentage,
  grokAutoCompactCancelled,
  grokAutoCompactCompleted,
  grokAutoCompactStarted,
  grokCompactionSummary,
  isCompactSummaryMessage,
  type CompactEvent,
} from "./compaction.js";
import {
  sourceSubagentRows,
  defaultListSubagents,
  defaultGetSubagentMessages,
  hasSubagentSpawn,
  spawnIdsOpen,
} from "./subagent-source.js";
import type { ListSubagents, GetSubagentMessages } from "./subagent-source.js";
import {
  collectSidechainToolUses,
  registerSidechainGateToolUses,
  type SidechainToolUse,
} from "./subagent-gate.js";
import { createSubagentWatcher } from "./subagent-watcher.js";
import type { SubagentWatcher } from "./subagent-watcher.js";
import { classifyDiffSource, diffToolCallUpdate } from "./diff-source.js";
import { guardEvent } from "./billing/entrypoint-guard.js";
import type { WatchedMessage } from "./billing/entrypoint-guard.js";
import {
  addUsage,
  contextTokensUsed,
  EMPTY_USAGE,
  usageUpdatesFor,
  type AccumulatedUsage,
  type UsageCarrier,
} from "./usage.js";
import { dispatchSlash, isAdvertisedSlash, parseSlashPrompt, type SlashSessionView } from "./slash.js";
import { fetchPlanUsage, type PlanUsageSource, type PlanUsageView } from "./plan-usage.js";
import {
  grokContextFromSnapshot,
  scanContextUsageFromJsonl,
  type ContextUsageSnapshot,
} from "./context-info.js";
import { createTurnResolver } from "./end-of-turn.js";
import type { DetectorSchedule, EndOfTurnDetector } from "./end-of-turn.js";
import { parseCcModsRelayMeta, sendPrompt, type CcModsRelayFlags } from "./engine-pty.js";
import { asAskQuestions, formAnswers, questionForm } from "./ask-user-question.js";
import { ENVIRONMENT_FILE, resolveTuiCwd, trustTuiCwd, workspaceOnClient, writeSessionMount } from "./environment.js";
import { debug } from "./debug.js";
import { answerPermission, answerQuestion, modChannelConnected, onModEvent, type ModEvent, type PermissionDecision } from "./mod-channel.js";
import { applyModEvent, stopReasonFromMod } from "./mod-live.js";
import {
  MODEL_CONTEXT_WINDOWS,
  MODEL_ID_CONTEXT_WINDOWS,
  modelSelectorDescription,
  DEFAULT_MODEL_INFO,
  REASONING_EFFORT_LEVELS,
  resolveCatalogValueFromModelId,
  isFastModeCapableModel,
  classifyFastModeSignal,
  FAST_MODE_CONFIG_ID,
  FAST_MODE_ON,
  FAST_MODE_OFF,
  createFastModeConfigOption,
  clientSupportsBooleanConfigOptions,
  resolveFastModeEnabled,
  ULTRACODE_CONFIG_ID,
  ULTRACODE_EFFORT_LEVEL,
  LEGACY_ULTRACODE_EFFORT_VALUE,
  ultracodeCommand,
  isUltracodeCapableModel,
  resolveUltracodeEnabled,
  createUltracodeConfigOption,
  classifyUltracodeReply,
} from "./model-catalog.js";
import { resolveModelCatalog, type SupportedModelsSource } from "./live-model-catalog.js";
import { applyUltracodeSettings } from "./gate/settings-writer.js";
import { discoverAgents, type AgentCatalogEntry } from "./agent-catalog.js";
import { discoverCommands } from "./command-catalog.js";
import { setupSessionGate } from "./permissions/gate-wiring.js";
import type { GatePty, SessionGate, SessionGateOptions } from "./permissions/gate-wiring.js";
import { translateMcpServers, writeMcpScratch, removeMcpScratch } from "./mcp-config-writer.js";
import {
  assertForwardingStdioMcp,
  buildLocalEnvironmentAppend,
  isLocalToolForwardEnabled,
  removeAppendSystemPromptFile,
  resolveDisallowedBuiltins,
  resolveForwardingCoverage,
  writeAppendSystemPromptFile,
  type ForwardingMcpServer,
  type LocalToolForwardMeta,
} from "./local-tool-forward.js";

import { materializeImage, cleanupMaterializedImages } from "./image-input.js";
import { deleteSessionIfStored } from "./session-delete.js";
import {
  extraFlagsWithModel,
  parseSessionCreateMeta,
  withDeniedAskUserQuestion,
} from "./session-create-meta.js";

export { permissionModeFromClientMeta } from "./session-create-meta.js";

export const CLAUDE_CONFIG_DIR =
  process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");

const MAX_TITLE_LENGTH = 256;

function sanitizeTitle(text: string): string {
  const sanitized = text
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (sanitized.length <= MAX_TITLE_LENGTH) {
    return sanitized;
  }
  return sanitized.slice(0, MAX_TITLE_LENGTH - 1) + "…";
}

function isoLastModified(lastModified: number | undefined): string | undefined {
  if (lastModified === undefined || !Number.isFinite(lastModified)) return undefined;
  const at = new Date(lastModified);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

export type GrokSessionRenameParams = {
  sessionId: string;
  title: string;
  cwd?: string;
  resetToAuto?: boolean;
};

export function parseGrokSessionRename(params: unknown): GrokSessionRenameParams {
  if (!params || typeof params !== "object") {
    throw RequestError.invalidParams(undefined, "session rename params required");
  }
  const p = params as Record<string, unknown>;
  const sessionId =
    (typeof p.sessionId === "string" && p.sessionId) ||
    (typeof p.session_id === "string" && p.session_id) ||
    "";
  const title =
    (typeof p.title === "string" && p.title) ||
    (typeof p.name === "string" && p.name) ||
    "";
  const cwd = typeof p.cwd === "string" ? p.cwd : undefined;
  const resetToAuto = p.resetToAuto === true || p.reset_to_auto === true;
  return { sessionId, title, cwd, resetToAuto };
}

export type GrokSessionIdParams = { sessionId: string };

export type GrokInterjectParams = {
  sessionId: string;
  text: string;
  interjectionId?: string;
  content?: PromptRequest["prompt"];
};

export function parseGrokInterject(params: unknown): GrokInterjectParams {
  if (!params || typeof params !== "object") {
    throw RequestError.invalidParams(undefined, "interject params required");
  }
  const p = params as Record<string, unknown>;
  const sessionId =
    (typeof p.sessionId === "string" && p.sessionId) ||
    (typeof p.session_id === "string" && p.session_id) ||
    "";
  if (!sessionId) throw RequestError.invalidParams(undefined, "sessionId is required");
  const text =
    (typeof p.text === "string" && p.text) ||
    (typeof p.message === "string" && p.message) ||
    "";
  const interjectionId =
    (typeof p.interjectionId === "string" && p.interjectionId) ||
    (typeof p.interjection_id === "string" && p.interjection_id) ||
    undefined;
  const content = Array.isArray(p.content) ? (p.content as PromptRequest["prompt"]) : undefined;
  return { sessionId, text, interjectionId, content };
}

export function parseGrokSessionId(params: unknown): GrokSessionIdParams {
  if (!params || typeof params !== "object") {
    throw RequestError.invalidParams(undefined, "sessionId is required");
  }
  const p = params as Record<string, unknown>;
  const sessionId =
    (typeof p.sessionId === "string" && p.sessionId) ||
    (typeof p.session_id === "string" && p.session_id) ||
    "";
  if (!sessionId) throw RequestError.invalidParams(undefined, "sessionId is required");
  return { sessionId };
}

const USD_TICKS_PER_USD = 10_000_000_000;

function grokExtSuccess<T>(result: T): { result: T } {
  return { result };
}

export interface Logger {
  log: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

export const DEFAULT_CONTEXT_WINDOW = 200000;

type Session = {
  pty: EngineTerminal;
  watcher?: JsonlWatcher | SessionWatcher;
  emitted: Set<string>;
  emittedNested: Set<string>;
  backgroundTaskEnds?: Map<string, BackgroundTaskEnd>;
  heldBackgroundExits?: Set<string>;
  lastEmittedTitle?: string;
  registeredSidechain?: Set<string>;
  sidechainParentMap?: Map<string, SidechainToolUse>;
  engine?: SessionEngine;
  cancelled: boolean;
  cwd: string;
  /** Working directory the ACP client passed to session/new (may differ from TUI cwd). */
  clientCwd: string;
  additionalDirectories?: string[];
  mcpConfigFile?: string;
  mcpServers?: NewSessionRequest["mcpServers"];
  localToolForward?: boolean;
  localToolForwardMeta?: LocalToolForwardMeta;
  forwardMcpServers?: ForwardingMcpServer[];
  appendSystemPromptFile?: string;
  disallowedTools?: string[];
  sessionFingerprint: string;
  settingsManager: SettingsManager;
  accumulatedUsage: AccumulatedUsage;
  lastContextUsed: number;
  lastCostUsd?: number;
  startedAtMs: number;
  modes: SessionModeState;
  modelInfos: ModelInfo[];
  allowBypass?: boolean;
  agents?: AgentCatalogEntry[];
  configOptions: SessionConfigOption[];
  contextWindowSize: number;
  taskState: TaskState;
  toolUseCache: ToolUseCache;
  guardChecked: boolean;
  usageDisabled: boolean;
  turnDetector?: EndOfTurnDetector;
  turnCancel?: () => void;
  detectorCursor?: number;
  pendingModelInjection?: string;
  pendingEffortInjection?: string;
  ultracodeOn?: boolean;
  ultracodeRefusal?: { scope: "model" | "workflows"; reason: string };
  pendingUltracodeInjection?: boolean;
  ultracodeReplyStop?: () => void;
  fastModeOn?: boolean;
  fastModeAvailable?: boolean;
  pendingFastInjection?: boolean;
  respawning?: boolean;
  interacted?: boolean;
  gate?: SessionGate;
  subagentWatcher?: SubagentWatcher;
  lastMessages?: SessionMessage[];
  lastContextSnapshot?: ContextUsageSnapshot;
  turnTempImagePaths?: string[];
  liveFromMod?: boolean;
  modTools?: Map<string, { tool: string; input: Record<string, unknown> }>;
  /** ACP client `PromptRequest._meta.promptId`, echoed on `session/update`. */
  currentPromptId?: string;
  /** Source session id when this session was created by `session/fork`. */
  forkedFrom?: string;
  /** Replayable parent turns the child JSONL is expected to inherit. */
  forkInheritCount?: number;
  /** How this live session was created. Unused `new` sessions are discarded on close/exit. */
  origin: "new" | "resume" | "fork";
  /** True once the ACP client sent `session/prompt` (including slash commands). */
  hadUserPrompt: boolean;
  /** JSONL uuids already projected as compaction UI. */
  emittedCompaction?: Set<string>;
  compactionLive?: { id: string; tokensBefore?: number; startedAt: number };
  /** Mid-turn `x.ai/interject` texts to skip as duplicate user_message_chunk. */
  pendingInterjectTexts?: string[];
  permissionAbort?: AbortController;
  /** Overlapping `session/prompt` RPCs waiting for the in-flight turn to finish. */
  queuedPrompts?: QueuedPrompt[];
};

type QueuedPrompt = {
  params: PromptRequest;
  resolve: (response: PromptResponse) => void;
  reject: (error: unknown) => void;
};

export interface StartedEngine {
  sessionId: string;
  pty: EngineTerminal;
  watcher?: JsonlWatcher | SessionWatcher;
  engine?: SessionEngine;
  cwd?: string;
  transcriptPath?: string;
}

export interface StartEngineArgs {
  sessionId?: string;
  cwd: string;
  resume?: boolean;
  /** Source session to `--resume` when `fork` is set. */
  resumeFrom?: string;
  /** Spawn `claude --resume SOURCE --fork-session --session-id NEW`. */
  fork?: boolean;
  baseEnv?: Record<string, string | undefined>;
  sessions?: Map<string, SessionEngine>;
  onEvent?: (sessionId: string) => void;
  replayOnly?: boolean;
  spawn?: import("./terminal-backend.js").TerminalSpawn;
  locateOptions?: LocateOptions;
  settingsFile?: string;
  permissionMode?: string;
  effortLevel?: string;
  agent?: string;
  inPlaceRespawn?: boolean;
  additionalDirectories?: string[];
  mcpConfigFile?: string;
  disallowedTools?: string[];
  appendSystemPromptFile?: string;
  extraFlags?: CcModsRelayFlags;
}

export type StartEngine = (args: StartEngineArgs) => Promise<StartedEngine> | StartedEngine;

export interface FastModeProbeContext {
  pty: EngineTerminal;
  cwd: string;
}

export type FastModeProbe = (ctx: FastModeProbeContext) => Promise<boolean> | boolean;

export const defaultFastModeProbe: FastModeProbe = () => false;

const FAST_PROBE_WINDOW_MS = 6000;
const FAST_PROBE_POLL_MS = 150;
const FAST_PROBE_REINJECT_MS = 2000;

export const driveFastModeProbe: FastModeProbe = async ({ pty }) => {
  let sub: { dispose(): void } | undefined;
  try {
    let buffer = "";
    sub = pty.onData((d) => {
      buffer += d;
    });
    const openPanel = () => {
      sendPrompt(pty, "/fast", (fn) => fn());
    };
    openPanel();
    const deadline = Date.now() + FAST_PROBE_WINDOW_MS;
    let nextReinject = Date.now() + FAST_PROBE_REINJECT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, FAST_PROBE_POLL_MS));
      const verdict = classifyFastModeSignal(buffer);
      if (verdict === "available") return true;
      if (verdict === "unavailable") return false;
      if (Date.now() >= nextReinject) {
        openPanel();
        nextReinject = Date.now() + FAST_PROBE_REINJECT_MS;
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    try {
      pty.write("\x1b");
    } catch {
    }
    try {
      sub?.dispose();
    } catch {
    }
  }
};

const REPLAY_ONLY_NOOP_PTY = {
  pid: -1,
  onExit: () => ({ dispose() {} }),
  onData: () => ({ dispose() {} }),
  resize() {},
  write() {},
  kill() {},
} as unknown as EngineTerminal;

export type StoredSessionInfo = {
  sessionId: string;
  cwd?: string;
  summary?: string;
  lastModified: number;
};

export interface AgentDeps {
  startEngine?: StartEngine;
  getMessages?: GetMessages;
  listSubagents?: ListSubagents;
  getSubagentMessages?: GetSubagentMessages;
  usageUpdate?: boolean;
  liveDiff?: boolean;
  diffEnrichOptions?: DiffEnrichedReaderOptions;
  findTranscript?: (sessionId: string) => string[];
  liveSubagentWatch?: boolean;
  schedule?: DetectorSchedule;
  cancelEscalationMs?: number;
  gate?: boolean;
  gateOptions?: Omit<SessionGateOptions, "client" | "onWarn">;
  discoverAgents?: (cwd: string) => AgentCatalogEntry[];
  discoverCommands?: (cwd: string) => AvailableCommand[];
  getSessionInfo?: (
    sessionId: string,
    options?: { dir?: string },
  ) => Promise<{ summary: string; lastModified?: number } | undefined>;
  listStoredSessions?: (opts: { dir?: string }) => Promise<StoredSessionInfo[]>;
  deleteStoredSession?: (sessionId: string) => Promise<void>;
  renameStoredSession?: (
    sessionId: string,
    title: string,
    options?: { dir?: string },
  ) => Promise<void>;
  fastModeProbe?: FastModeProbe;
  modelCatalogSource?: SupportedModelsSource;
  getPlanUsage?: PlanUsageSource;
  /** How long `session/load` waits for a forked child JSONL to inherit parent turns. */
  forkHistoryWaitMs?: number;
}

async function defaultGetPlanUsage(): Promise<PlanUsageView | undefined> {
  try {
    return await fetchPlanUsage();
  } catch {
    return undefined;
  }
}

export async function defaultStartEngine(args: StartEngineArgs): Promise<StartedEngine> {

  if (args.replayOnly && args.sessionId) {
    const { cwd, transcriptPath } = await resolveWatchTarget(args.sessionId, {
      ...args.locateOptions,
    });
    return {
      sessionId: args.sessionId,
      pty: REPLAY_ONLY_NOOP_PTY,
      watcher: undefined,
      engine: undefined,
      cwd,
      transcriptPath,
    };
  }

  if (args.fork && args.resumeFrom && args.sessionId) {
    const handle = spawnResumePty({
      sessionId: args.resumeFrom,
      forkedSessionId: args.sessionId,
      cwd: args.cwd,
      baseEnv: args.baseEnv,
      spawn: args.spawn,
      permissionMode: args.permissionMode,
      effortLevel: args.effortLevel,
      agent: args.agent,
      additionalDirectories: args.additionalDirectories,
      mcpConfigFile: args.mcpConfigFile,
      disallowedTools: args.disallowedTools,
      appendSystemPromptFile: args.appendSystemPromptFile,
      extraFlags: args.extraFlags,
    });
    const engine = new SessionEngine({ handle, watcher: undefined, sessions: args.sessions });
    const ac = new AbortController();
    engine.setPendingDiscovery(ac);
    void (async () => {
      try {
        const { transcriptPath, cwd } = await resolveWatchTarget(args.sessionId!, {
          watchdogMs: Infinity,
          ...args.locateOptions,
          signal: ac.signal,
        });
        const watcher = createJsonlWatcher({
          sessionId: args.sessionId!,
          transcriptPath,
          dir: cwd ?? args.cwd,
          onEvent: () => args.onEvent?.(args.sessionId!),
        });
        engine.watcher = watcher;
        args.onEvent?.(args.sessionId!);
      } catch (err) {
        if ((err as { name?: string } | undefined)?.name === "AbortError") return;
        console.error(
          `[acp-agent] fork-session transcript discovery failed for ${args.sessionId}:`,
          err,
        );
      }
    })();
    return {
      sessionId: args.sessionId,
      pty: handle.pty,
      watcher: undefined,
      engine,
      cwd: args.cwd,
    };
  }

  if (args.resume && args.sessionId) {
    const handle = spawnResumePty({
      sessionId: args.sessionId,
      cwd: args.cwd,
      baseEnv: args.baseEnv,
      spawn: args.spawn,
      permissionMode: args.permissionMode,
      effortLevel: args.effortLevel,
      agent: args.agent,
      additionalDirectories: args.additionalDirectories,
      mcpConfigFile: args.mcpConfigFile,
      disallowedTools: args.disallowedTools,
      appendSystemPromptFile: args.appendSystemPromptFile,
      extraFlags: args.extraFlags,
    });
    if (args.inPlaceRespawn) {
      const engine = new SessionEngine({ handle, watcher: undefined, sessions: args.sessions });
      const ac = new AbortController();
      engine.setPendingDiscovery(ac);
      void (async () => {
        try {
          const { transcriptPath, cwd } = await resolveWatchTarget(args.sessionId!, {
            watchdogMs: Infinity,
            ...args.locateOptions,
            signal: ac.signal,
          });
          const watcher = createJsonlWatcher({
            sessionId: args.sessionId!,
            transcriptPath,
            dir: cwd ?? args.cwd,
            onEvent: () => args.onEvent?.(args.sessionId!),
          });
          engine.watcher = watcher;
          args.onEvent?.(args.sessionId!);
        } catch (err) {
          if ((err as { name?: string } | undefined)?.name === "AbortError") return;
          console.error(
            `[acp-agent] in-place re-spawn transcript discovery failed for ${args.sessionId}:`,
            err,
          );
        }
      })();
      return {
        sessionId: args.sessionId,
        pty: handle.pty,
        watcher: undefined,
        engine,
        cwd: args.cwd,
      };
    }

    const { transcriptPath, cwd } = await resolveWatchTarget(args.sessionId, {
      ...args.locateOptions,
    });
    const watcher = createJsonlWatcher({
      sessionId: args.sessionId,
      transcriptPath,
      dir: cwd,
      onEvent: () => args.onEvent?.(args.sessionId!),
    });
    const engine = new SessionEngine({ handle, watcher, sessions: args.sessions });
    return { sessionId: args.sessionId, pty: handle.pty, watcher, engine, cwd };
  }

  const engine = createSessionEngine({
    cwd: args.cwd,
    baseEnv: args.baseEnv,
    sessions: args.sessions,
    spawn: args.spawn,
    sessionId: args.sessionId,
    permissionMode: args.permissionMode,
    effortLevel: args.effortLevel,
    agent: args.agent,
    settingsFile: args.settingsFile,
    additionalDirectories: args.additionalDirectories,
    mcpConfigFile: args.mcpConfigFile,
    disallowedTools: args.disallowedTools,
    appendSystemPromptFile: args.appendSystemPromptFile,
    extraFlags: args.extraFlags,
  });

  const ac = new AbortController();
  engine.setPendingDiscovery(ac);

  void (async () => {
    try {
      const { transcriptPath, cwd } = await resolveWatchTarget(engine.sessionId, {
        watchdogMs: Infinity,
        ...args.locateOptions,
        signal: ac.signal,
      });
      const watcher = createJsonlWatcher({
        sessionId: engine.sessionId,
        transcriptPath,
        dir: cwd ?? args.cwd,
        onEvent: () => args.onEvent?.(engine.sessionId),
      });
      engine.watcher = watcher;
      args.onEvent?.(engine.sessionId);
    } catch (err) {
      if ((err as { name?: string } | undefined)?.name === "AbortError") return;
      console.error(
        `[acp-agent] fresh-session transcript discovery failed for ${engine.sessionId}:`,
        err,
      );
    }
  })();

  return {
    sessionId: engine.sessionId,
    pty: engine.pty,
    watcher: undefined,
    engine,
    cwd: args.cwd,
  };
}

function resolveAdditionalDirs(p: {
  additionalDirectories?: string[];
  _meta?: NewSessionRequest["_meta"];
}): string[] {
  const roots = (p._meta as NewSessionMeta | null | undefined)?.additionalRoots;
  return p.additionalDirectories ?? roots ?? [];
}

function computeSessionFingerprint(params: {
  cwd: string;
  mcpServers?: NewSessionRequest["mcpServers"];
  additionalDirectories?: string[];
  _meta?: NewSessionRequest["_meta"];
}): string {
  const servers = [...(params.mcpServers ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const dirs = [...resolveAdditionalDirs(params)].sort();
  return JSON.stringify({ cwd: params.cwd, mcpServers: servers, additionalDirectories: dirs });
}

function sessionMatchesCwd(
  clientCwd: string,
  tuiCwd: string | undefined,
  ...candidates: Array<string | undefined>
): boolean {
  return candidates.some((cwd) => cwd === clientCwd || (tuiCwd !== undefined && cwd === tuiCwd));
}

function listedSessionCwd(
  clientCwd: string | undefined,
  tuiCwd: string | undefined,
  storedCwd: string | undefined,
): string | undefined {
  if (clientCwd && (!storedCwd || storedCwd === clientCwd || storedCwd === tuiCwd)) {
    return clientCwd;
  }
  return storedCwd;
}

type BackgroundTerminal =
  | {
      handle: EngineTerminal;
      status: "started";
      lastOutput: TerminalOutputResponse | null;
    }
  | {
      status: "aborted" | "exited" | "killed" | "timedOut";
      pendingOutput: TerminalOutputResponse;
    };

export type SDKMessageFilter = {
  type: string;
  subtype?: string;
  origin?: SDKMessageOrigin["kind"];
};

export type NewSessionMeta = {
  claudeCode?: {
    options?: Options;
    localToolForward?: boolean | {
      enabled?: boolean;
      disallowedTools?: string[];
      requiredTools?: string[];
      providedTools?: Record<string, string[]>;
    };
    emitRawSDKMessages?: boolean | SDKMessageFilter[];
  };
  additionalRoots?: string[];
  yoloMode?: boolean;
  autoMode?: boolean;
  modelId?: string;
  sessionId?: string;
  askUserQuestion?: boolean;
  agentProfile?: string;
};

type GatewayAuthMeta = {
  gateway: {
    baseUrl: string;
    headers: Record<string, string>;
  };
};

type GatewayAuthRequest = AuthenticateRequest & { _meta?: GatewayAuthMeta };

export type ToolUpdateMeta = {
  claudeCode?: {
    toolName: string;
    toolResponse?: unknown;
    skill?: string;
    skillPath?: string;
  };
  terminal_info?: {
    terminal_id: string;
  };
  terminal_output?: {
    terminal_id: string;
    data: string;
  };
  terminal_exit?: {
    terminal_id: string;
    exit_code: number | null;
    signal: string | null;
  };
};

function claudeCodeMetaFromToolUse(
  toolUse: { name: string; input?: unknown },
  cwd?: string,
): NonNullable<ToolUpdateMeta["claudeCode"]> {
  const skillName =
    toolUse.name === "Skill"
      ? (toolUse.input as { skill?: string } | null | undefined)?.skill
      : undefined;
  const skillPath = skillName ? resolveSkillPath(skillName, cwd) : undefined;
  return {
    toolName: toolUse.name,
    ...(skillName ? { skill: skillName } : {}),
    ...(skillPath ? { skillPath } : {}),
  };
}

const SKILL_CONTAINER_DIRS = [".claude/skills", ".agents/skills"] as const;

function resolveSkillPath(skillName: string, cwd?: string): string | undefined {
  if (!cwd) {
    return undefined;
  }
  const colon = skillName.indexOf(":");
  const scope = colon < 0 ? undefined : skillName.slice(0, colon);
  const name = colon < 0 ? skillName : skillName.slice(colon + 1);
  if (!name) {
    return undefined;
  }
  const candidates: string[] = [];
  const addCandidates = (base: string) => {
    for (const container of SKILL_CONTAINER_DIRS) {
      candidates.push(path.join(base, container, name, "SKILL.md"));
    }
  };
  if (scope) {
    addCandidates(path.join(cwd, scope));
    candidates.push(path.join(cwd, ".claude/plugins", scope, "skills", name, "SKILL.md"));
  }
  addCandidates(cwd);
  addCandidates(os.homedir());
  return candidates.find((candidate) => existsSync(candidate));
}

export type ToolUseCache = {
  [key: string]: {
    type: "tool_use" | "server_tool_use" | "mcp_tool_use";
    id: string;
    name: string;
    input: unknown;
  };
};

function shouldHideClaudeAuth(): boolean {
  return process.argv.includes("--hide-claude-auth");
}

const IS_ROOT = (process.geteuid?.() ?? process.getuid?.()) === 0;
const ALLOW_BYPASS = !IS_ROOT || !!process.env.IS_SANDBOX;

export function sessionAllowsBypass(permissions: Settings["permissions"] | undefined): boolean {
  return ALLOW_BYPASS && permissions?.disableBypassPermissionsMode !== "disable";
}

const LOCAL_ONLY_COMMANDS = new Set(["/heapdump", "/extra-usage"]);

const REPLAY_HIDDEN_COMMANDS = new Set([
  ...LOCAL_ONLY_COMMANDS,
  "/compact",
  "/model",
  "/status",
  "/effort",
  "/fast",
  "/context",
]);

/** Local TUI commands whose stdout is useful in an ACP client. */
const ACP_STATUS_COMMANDS = new Set(["/usage"]);

const FORK_HISTORY_WAIT_MS = 8_000;
const FORK_HISTORY_POLL_MS = 80;

function replayableTurnCount(messages: SessionMessage[]): number {
  return linearizeTurns(messages).length;
}

function sessionOrigin(opts: { resume?: string; forkSession?: boolean }): "new" | "resume" | "fork" {
  if (opts.forkSession) return "fork";
  if (opts.resume) return "resume";
  return "new";
}

function isUnusedBlankSession(session: Session): boolean {
  return session.origin === "new" && !session.hadUserPrompt && !session.lastEmittedTitle;
}

const LOCAL_COMMAND_MARKERS = [
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-stderr",
  "task-notification",
].map((tag) => ({ open: `<${tag}>`, close: `</${tag}>` }));

function stripMarkerTags(text: string): string {
  const dead = new Set<string>();
  let result = "";
  let copiedUpTo = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "<") {
      const marker = LOCAL_COMMAND_MARKERS.find(
        (m) => !dead.has(m.open) && text.startsWith(m.open, i),
      );
      if (marker) {
        const end = text.indexOf(marker.close, i + marker.open.length);
        if (end !== -1) {
          result += text.slice(copiedUpTo, i);
          i = copiedUpTo = end + marker.close.length;
          continue;
        }
        dead.add(marker.open);
      }
    }
    i++;
  }
  return result + text.slice(copiedUpTo);
}

function markerTagText(text: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = text.indexOf(open);
  if (start === -1) return undefined;
  const end = text.indexOf(close, start + open.length);
  if (end === -1) return undefined;
  return text.slice(start + open.length, end);
}

function hasMarkerTag(text: string, tag: string): boolean {
  return markerTagText(text, tag) !== undefined;
}

function commandNameFromMarkers(text: string): string | undefined {
  const commandName = markerTagText(text, "command-name")?.trim();
  if (!commandName?.startsWith("/")) return undefined;
  return commandName.split(" ", 1)[0];
}

function statusCommandOutputText(text: string): string | null {
  const commandName = commandNameFromMarkers(text);
  if (!commandName || !ACP_STATUS_COMMANDS.has(commandName)) return null;
  const stdout = markerTagText(text, "local-command-stdout") ?? "";
  const stderr = markerTagText(text, "local-command-stderr") ?? "";
  const body = [stdout, stderr].filter((part) => part.trim()).join("\n");
  return body.trim() ? body : null;
}

function commandInvocationFromMarkerOnlyText(text: string): string | null {
  if (hasMarkerTag(text, "local-command-stdout") || hasMarkerTag(text, "local-command-stderr")) {
    return null;
  }
  const commandName = commandNameFromMarkers(text);
  if (!commandName) return null;
  if (REPLAY_HIDDEN_COMMANDS.has(commandName)) return null;

  const rawName = markerTagText(text, "command-name")?.trim() ?? commandName;
  const commandArgs = markerTagText(text, "command-args")?.trim();
  return commandArgs ? `${rawName} ${commandArgs}` : rawName;
}

function stripLocalCommandMetadataText(text: string): string | null {
  const status = statusCommandOutputText(text);
  if (status !== null) return status;
  const stripped = stripMarkerTags(text);
  if (stripped.trim() !== "") return stripped;
  return commandInvocationFromMarkerOnlyText(text);
}

export function stripLocalCommandMetadata(content: unknown): unknown | null {
  if (typeof content === "string") {
    return stripLocalCommandMetadataText(content);
  }
  if (!Array.isArray(content)) return content;

  const kept: unknown[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      (block as { type: unknown }).type === "text" &&
      "text" in block &&
      typeof (block as { text: unknown }).text === "string"
    ) {
      const stripped = stripLocalCommandMetadataText((block as { text: string }).text);
      if (stripped === null) continue;
      kept.push({ ...(block as object), text: stripped });
    } else {
      kept.push(block);
    }
  }
  if (kept.length === 0) return null;
  return kept;
}

export function statusCommandOutput(content: unknown): string | null {
  if (typeof content === "string") return statusCommandOutputText(content);
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      (block as { type: unknown }).type === "text" &&
      "text" in block &&
      typeof (block as { text: unknown }).text === "string"
    ) {
      const status = statusCommandOutputText((block as { text: string }).text);
      if (status) parts.push(status);
    }
  }
  return parts.length ? parts.join("\n") : null;
}

export function isLocalCommandMetadata(content: unknown): boolean {
  return stripLocalCommandMetadata(content) === null;
}

const PERMISSION_MODE_ALIASES: Record<string, PermissionMode> = {
  auto: "auto",
  default: "default",
  manual: "default",
  ask: "default",
  acceptedits: "acceptEdits",
  dontask: "dontAsk",
  plan: "plan",
  bypasspermissions: "bypassPermissions",
  bypass: "bypassPermissions",
  "always-approve": "bypassPermissions",
  alwaysapprove: "bypassPermissions",
  yolo: "bypassPermissions",
};

export function resolvePermissionMode(
  defaultMode?: unknown,
  logger: Logger = console,
  allowBypass: boolean = ALLOW_BYPASS,
): PermissionMode {
  if (defaultMode === undefined) {
    return "default";
  }

  if (typeof defaultMode !== "string") {
    logger.error("Ignoring permissions.defaultMode from settings: expected a string.");
    return "default";
  }

  const normalized = defaultMode.trim().toLowerCase();
  if (normalized === "") {
    logger.error("Ignoring permissions.defaultMode from settings: expected a non-empty string.");
    return "default";
  }

  const mapped = PERMISSION_MODE_ALIASES[normalized];
  if (!mapped) {
    logger.error(`Ignoring permissions.defaultMode from settings: unknown value '${defaultMode}'.`);
    return "default";
  }

  if (mapped === "bypassPermissions" && !allowBypass) {
    logger.error(
      ALLOW_BYPASS
        ? "Ignoring permissions.defaultMode from settings: bypassPermissions is disabled by permissions.disableBypassPermissionsMode."
        : "Ignoring permissions.defaultMode from settings: bypassPermissions is not available when running as root.",
    );
    return "default";
  }

  return mapped;
}

const CYCLABLE_MODES = new Set<string>(["default", "acceptEdits", "plan", "auto"]);

const MODE_CYCLE_KEY = "\x1b[Z";

const MODE_CYCLE_STEP_TIMEOUT_MS = 2000;
const MODE_CYCLE_POLL_MS = 50;

const MODEL_CONFIRM_DELAY_MS = 800;

const ULTRACODE_REPLY_WINDOW_MS = 5000;
const ULTRACODE_REPLY_BUFFER_CHARS = 8192;

export function describeAlwaysAllow(
  suggestions: PermissionUpdate[] | undefined,
  toolName: string,
): string {
  if (!suggestions || suggestions.length === 0) {
    return `Always Allow all ${toolName}`;
  }

  const ruleLabels: string[] = [];
  const directories: string[] = [];

  for (const update of suggestions) {
    if (update.type === "addRules" && update.behavior === "allow") {
      for (const rule of update.rules) {
        ruleLabels.push(
          rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : `all ${rule.toolName}`,
        );
      }
    } else if (update.type === "addDirectories") {
      directories.push(...update.directories);
    }
  }

  const parts: string[] = [];
  if (ruleLabels.length > 0) {
    parts.push(ruleLabels.join(", "));
  }
  if (directories.length > 0) {
    parts.push(`access to ${directories.join(", ")}`);
  }

  if (parts.length === 0) {
    return `Always Allow all ${toolName}`;
  }

  return `Always Allow ${parts.join(" and ")}`;
}

function registerGateToolUses(raw: unknown, gate: SessionGate): void {
  const msg = raw as { type?: unknown; message?: { content?: unknown } };
  if (msg === null || typeof msg !== "object" || msg.type !== "assistant") return;
  const content = msg.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (
      block !== null &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "tool_use" &&
      typeof (block as { id?: unknown }).id === "string" &&
      (block as { id: string }).id.length > 0
    ) {
      gate.correlator.register((block as { id: string }).id);
    }
  }
}

function promptIdFromMeta(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const id = (meta as { promptId?: unknown }).promptId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function isSendNowMeta(meta: unknown): boolean {
  if (!meta || typeof meta !== "object") return false;
  return (meta as { sendNow?: unknown }).sendNow === true;
}

function deriveSubagentLabel(
  messages: SessionMessage[],
  parentId: string | null,
): string | undefined {
  if (parentId === null) return undefined;
  for (const msg of messages) {
    if (msg === null || typeof msg !== "object") continue;
    const inner = (msg as { message?: unknown }).message;
    if (inner === null || typeof inner !== "object") continue;
    const content = (inner as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block === null || typeof block !== "object") continue;
      const b = block as { type?: unknown; id?: unknown; name?: unknown; input?: unknown };
      if (b.type !== "tool_use" || b.id !== parentId) continue;
      if (b.name !== "Task" && b.name !== "Agent") continue;
      const input = b.input;
      if (input === null || typeof input !== "object") return undefined;
      const i = input as { subagent_type?: unknown; description?: unknown };
      if (typeof i.subagent_type === "string") return i.subagent_type;
      if (typeof i.description === "string") return i.description;
      return undefined;
    }
  }
  return undefined;
}

export interface AcpClient {
  sessionUpdate(params: SessionNotification): Promise<void>;
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
  createElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse>;
  extNotify?(method: string, params: unknown): Promise<void>;
}

export class ClientConnection implements AcpClient {
  constructor(private readonly ctx: AgentContext) {}

  sessionUpdate(params: SessionNotification): Promise<void> {
    return this.ctx.notify(methods.client.session.update, params);
  }

  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return this.ctx.request(methods.client.session.requestPermission, params);
  }

  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    return this.ctx.request(methods.client.fs.readTextFile, params);
  }

  writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    return this.ctx.request(methods.client.fs.writeTextFile, params);
  }

  createElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    return this.ctx.request(methods.client.elicitation.create, params);
  }

  extNotify(method: string, params: unknown): Promise<void> {
    return this.ctx.notify(method, params);
  }
}

export class ClaudeAcpAgent {
  sessions: {
    [key: string]: Session;
  };
  client: AcpClient;
  toolUseCache: ToolUseCache;
  backgroundTerminals: { [key: string]: BackgroundTerminal } = {};
  clientCapabilities?: ClientCapabilities;
  clientSupportsElicitationForm: boolean = false;
  relayFlags: CcModsRelayFlags = {};
  logger: Logger;
  gatewayAuthRequest?: GatewayAuthRequest;
  private readonly startEngine: StartEngine;
  private readonly getMessages?: GetMessages;
  private readonly precompactOptions: PrecompactHistoryOptions;
  private readonly listSubagents: ListSubagents;
  private readonly getSubagentMessages: GetSubagentMessages;
  private readonly usageUpdate: boolean;
  private readonly liveSubagentWatch: boolean;
  private readonly schedule: DetectorSchedule;
  private readonly cancelEscalationMs: number;
  private readonly gateEnabled: boolean;
  private readonly gateOptions?: Omit<SessionGateOptions, "client" | "onWarn">;
  private readonly discoverAgents: (cwd: string) => AgentCatalogEntry[];
  private readonly discoverCommands: (cwd: string) => AvailableCommand[];
  private readonly getSessionInfo: (
    sessionId: string,
    options?: { dir?: string },
  ) => Promise<{ summary: string; lastModified?: number } | undefined>;
  private readonly listStoredSessions: (opts: { dir?: string }) => Promise<StoredSessionInfo[]>;
  private readonly deleteStoredSession: (sessionId: string) => Promise<void>;
  private readonly renameStoredSession: (
    sessionId: string,
    title: string,
    options?: { dir?: string },
  ) => Promise<void>;
  private readonly fastModeProbe: FastModeProbe;
  private readonly modelCatalogSource: SupportedModelsSource | undefined;
  private readonly getPlanUsage: PlanUsageSource;
  private readonly locateTranscriptFiles: (sessionId: string) => string[];
  private readonly forkHistoryWaitMs: number;
  private readonly engines: Map<string, SessionEngine> = new Map();
  private readonly unsubMod: () => void;

  constructor(
    client: AcpClient,
    logger?: Logger,
    deps: AgentDeps = {},
  ) {
    this.sessions = {};
    this.client = this.wrapClient(client);
    this.toolUseCache = {};
    this.logger = logger ?? console;
    this.startEngine = deps.startEngine ?? defaultStartEngine;
    this.fastModeProbe = deps.fastModeProbe ?? defaultFastModeProbe;
    this.modelCatalogSource = deps.modelCatalogSource;
    this.getPlanUsage = deps.getPlanUsage ?? defaultGetPlanUsage;
    this.locateTranscriptFiles = deps.findTranscript ?? findTranscript;
    this.forkHistoryWaitMs = deps.forkHistoryWaitMs ?? FORK_HISTORY_WAIT_MS;
    this.getMessages =
      (deps.liveDiff ?? false)
        ? createDiffEnrichedReader(deps.getMessages ?? defaultGetMessages, {
            ...deps.diffEnrichOptions,
            onRawLines: (sid, lines) => {
              const session = this.sessions[sid];
              if (session) session.backgroundTaskEnds = backgroundTaskEnds(lines);
            },
          })
        : deps.getMessages;
    this.precompactOptions = {
      findTranscript: deps.findTranscript ?? deps.diffEnrichOptions?.findTranscript,
      hydrateToolUseResult: deps.liveDiff ?? false,
    };
    this.listSubagents = deps.listSubagents ?? defaultListSubagents;
    this.getSubagentMessages = deps.getSubagentMessages ?? defaultGetSubagentMessages;
    this.usageUpdate = deps.usageUpdate ?? false;
    this.liveSubagentWatch = deps.liveSubagentWatch ?? false;
    this.schedule =
      deps.schedule ??
      ((fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      });
    this.cancelEscalationMs = deps.cancelEscalationMs ?? 1000;
    this.gateEnabled = deps.gate ?? false;
    this.gateOptions = deps.gateOptions;
    this.discoverAgents = deps.discoverAgents ?? discoverAgents;
    this.discoverCommands = deps.discoverCommands ?? discoverCommands;
    this.getSessionInfo = deps.getSessionInfo ?? getSessionInfo;
    this.listStoredSessions = deps.listStoredSessions ?? ((opts) => listSessions(opts));
    this.deleteStoredSession =
      deps.deleteStoredSession ?? ((sessionId) => deleteSessionIfStored(sessionId, deleteSession));
    this.renameStoredSession =
      deps.renameStoredSession ?? ((sessionId, title, options) => renameSession(sessionId, title, options));
    this.unsubMod = onModEvent((event) => {
      void this.handleModEvent(event).catch((error) => this.logger.error("[mod-live]", error));
    });
  }

  private wrapClient(client: AcpClient): AcpClient {
    return {
      sessionUpdate: (params) => this.stampAndForwardSessionUpdate(client, params),
      requestPermission: (p) => client.requestPermission(p),
      readTextFile: (p) => client.readTextFile(p),
      writeTextFile: (p) => client.writeTextFile(p),
      createElicitation: (p) => client.createElicitation(p),
      extNotify: client.extNotify
        ? (method, params) => client.extNotify!(method, params)
        : undefined,
    };
  }

  /** Host TUI cwd for an ACP client cwd. Session JSONL is keyed by this path. */
  private tuiCwdFor(clientCwd: string): string {
    const pluginDir = process.env.CC_MODS_PLUGIN_DIR;
    return resolveTuiCwd(
      clientCwd,
      workspaceOnClient({
        fs: this.clientCapabilities?.fs,
        environmentFile: Boolean(pluginDir && existsSync(path.join(pluginDir, ENVIRONMENT_FILE))),
      }),
    );
  }

  private stampAndForwardSessionUpdate(
    client: AcpClient,
    params: SessionNotification,
  ): Promise<void> {
    const pid = this.sessions[params.sessionId]?.currentPromptId;
    if (!pid) return client.sessionUpdate(params);
    if (promptIdFromMeta(params._meta)) return client.sessionUpdate(params);
    return client.sessionUpdate({
      ...params,
      _meta: { ...params._meta, promptId: pid },
    });
  }

  async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = request.clientCapabilities;
    this.relayFlags = parseCcModsRelayMeta(request._meta);
    const elicitationForm = request.clientCapabilities?.elicitation?.form;
    this.clientSupportsElicitationForm = elicitationForm !== undefined && elicitationForm !== null;
    this.logger.error(
      `[065] clientCapabilities.elicitation.form advertised: ${this.clientSupportsElicitationForm}`,
    );

    const supportsGatewayAuth = request.clientCapabilities?.auth?._meta?.gateway === true;

    const gatewayAuthMethod: AuthMethod = {
      id: "gateway",
      name: "Custom model gateway",
      description: "Use a custom gateway to authenticate and access models",
      _meta: {
        gateway: {
          protocol: "anthropic",
        },
      },
    };

    const gatewayBedrockAuthMethod: AuthMethod = {
      id: "gateway-bedrock",
      name: "Custom model gateway",
      description: "Use a custom gateway to authenticate and access models",
      _meta: {
        gateway: {
          protocol: "bedrock",
        },
      },
    };

    const supportsTerminalAuth = request.clientCapabilities?.auth?.terminal === true;
    const supportsMetaTerminalAuth = request.clientCapabilities?._meta?.["terminal-auth"] === true;

    const isRemote = !!(
      process.env.NO_BROWSER ||
      process.env.SSH_CONNECTION ||
      process.env.SSH_CLIENT ||
      process.env.SSH_TTY ||
      process.env.CLAUDE_CODE_REMOTE
    );
    const terminalAuthMethods: AuthMethod[] = [];

    if (isRemote) {
      const remoteLoginMethod: AuthMethod = {
        description: "Run `claude /login` in the terminal",
        name: "Log in with Claude",
        id: "claude-login",
        type: "terminal",
        args: ["--cli"],
      };

      if (supportsMetaTerminalAuth) {
        remoteLoginMethod._meta = {
          "terminal-auth": {
            command: process.execPath,
            args: [...process.argv.slice(1), "--cli"],
            label: "Claude Login",
          },
        };
      }

      if (!shouldHideClaudeAuth() && (supportsTerminalAuth || supportsMetaTerminalAuth)) {
        terminalAuthMethods.push(remoteLoginMethod);
      }
    } else {
      const claudeLoginMethod: AuthMethod = {
        description: "Use Claude subscription ",
        name: "Claude Subscription",
        id: "claude-ai-login",
        type: "terminal",
        args: ["--cli", "auth", "login", "--claudeai"],
      };

      const consoleLoginMethod: AuthMethod = {
        description: "Use Anthropic Console (API usage billing)",
        name: "Anthropic Console",
        id: "console-login",
        type: "terminal",
        args: ["--cli", "auth", "login", "--console"],
      };

      if (supportsMetaTerminalAuth) {
        const baseArgs = process.argv.slice(1);
        claudeLoginMethod._meta = {
          "terminal-auth": {
            command: process.execPath,
            args: [...baseArgs, "--cli", "auth", "login", "--claudeai"],
            label: "Claude Login",
          },
        };
        consoleLoginMethod._meta = {
          "terminal-auth": {
            command: process.execPath,
            args: [...baseArgs, "--cli", "auth", "login", "--console"],
            label: "Anthropic Console Login",
          },
        };
      }

      if (!shouldHideClaudeAuth() && (supportsTerminalAuth || supportsMetaTerminalAuth)) {
        terminalAuthMethods.push(claudeLoginMethod);
      }
      if (supportsTerminalAuth || supportsMetaTerminalAuth) {
        terminalAuthMethods.push(consoleLoginMethod);
      }
    }

    return {
      protocolVersion: 1,
      agentCapabilities: {
        _meta: {
          claudeCode: {
            promptQueueing: true,
          },
        },
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: true,
          sse: true,
        },
        loadSession: true,
        sessionCapabilities: {
          additionalDirectories: {},
          close: {},
          delete: {},
          fork: {},
          list: {},
          resume: {},
          title: {},
        },
      },
      agentInfo: {
        name: "claude",
        title: "Claude",
        version: packageJson.version,
      },
      authMethods: [
        ...terminalAuthMethods,
        ...(supportsGatewayAuth ? [gatewayAuthMethod, gatewayBedrockAuthMethod] : []),
      ],
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const response = await this.createSession(params, {
      resume: (params._meta as NewSessionMeta | undefined)?.claudeCode?.options?.resume,
    });
    setTimeout(() => {
      this.sendAvailableCommandsUpdate(response.sessionId);
    }, 0);
    return response;
  }

  async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    const source = this.sessions[params.sessionId];
    const cwd = params.cwd || source?.clientCwd || source?.cwd;
    if (!cwd) {
      throw RequestError.resourceNotFound(params.sessionId);
    }
    if (!source && !(await this.storedSessionExists(params.sessionId, cwd))) {
      throw RequestError.resourceNotFound(params.sessionId);
    }
    const response = await this.createSession(
      {
        cwd,
        mcpServers: params.mcpServers ?? source?.mcpServers ?? [],
        additionalDirectories: params.additionalDirectories ?? source?.additionalDirectories,
        _meta: params._meta,
      },
      {
        resume: params.sessionId,
        forkSession: true,
      },
    );
    const child = this.sessions[response.sessionId];
    if (child) {
      child.forkedFrom = params.sessionId;
      try {
        const parentMessages = await this.readSessionMessages(params.sessionId, child.cwd);
        child.forkInheritCount = replayableTurnCount(parentMessages);
        if (source) source.lastMessages = parentMessages;
      } catch (error) {
        this.logger.error("[acp-agent] fork parent history lookup failed:", error);
      }
    }
    setTimeout(() => {
      this.sendAvailableCommandsUpdate(response.sessionId);
    }, 0);
    return response;
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const result = await this.getOrCreateSession(params);
    const session = this.sessions[params.sessionId];
    if (session && session.emitted.size === 0 && session.forkedFrom) {
      await this.replaySessionHistory(params.sessionId);
    }

    setTimeout(() => {
      this.sendAvailableCommandsUpdate(params.sessionId);
    }, 0);
    return result;
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const result = await this.getOrCreateSession(params, { replayOnly: true });

    await this.replaySessionHistory(params.sessionId, { force: true });

    setTimeout(() => {
      this.sendAvailableCommandsUpdate(params.sessionId);
    }, 0);

    return result;
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const cwdFilter = params.cwd ?? undefined;
    const tuiCwd = cwdFilter ? this.tuiCwdFor(cwdFilter) : undefined;
    const byId = new Map<string, ListSessionsResponse["sessions"][number]>();

    for (const [sessionId, session] of Object.entries(this.sessions)) {
      if (cwdFilter && !sessionMatchesCwd(cwdFilter, tuiCwd, session.clientCwd, session.cwd)) {
        continue;
      }
      byId.set(sessionId, {
        sessionId,
        cwd: session.clientCwd || session.cwd,
        ...(session.additionalDirectories && session.additionalDirectories.length > 0
          ? { additionalDirectories: session.additionalDirectories }
          : {}),
        ...(session.lastEmittedTitle ? { title: session.lastEmittedTitle } : {}),
        updatedAt: new Date().toISOString(),
      });
    }

    try {
      const dirs = new Set<string | undefined>();
      if (cwdFilter) {
        dirs.add(tuiCwd);
        dirs.add(cwdFilter);
      } else {
        dirs.add(undefined);
      }
      for (const dir of dirs) {
        const stored = await this.listStoredSessions({ dir });
        for (const session of stored) {
          if (cwdFilter && session.cwd && !sessionMatchesCwd(cwdFilter, tuiCwd, session.cwd)) {
            continue;
          }
          const listedCwd = listedSessionCwd(cwdFilter, tuiCwd, session.cwd);
          if (!listedCwd) continue;
          const existing = byId.get(session.sessionId);
          const title = session.summary ? sanitizeTitle(session.summary) : undefined;
          if (existing) {
            if (!existing.title && title) existing.title = title;
            continue;
          }
          byId.set(session.sessionId, {
            sessionId: session.sessionId,
            cwd: listedCwd,
            ...(title ? { title } : {}),
            updatedAt: new Date(session.lastModified).toISOString(),
          });
        }
      }
    } catch (err) {
      this.logger.error("[acp-agent] listSessions stored lookup failed:", err);
    }

    return {
      sessions: [...byId.values()],
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    if (_params.methodId === "gateway" || _params.methodId === "gateway-bedrock") {
      this.gatewayAuthRequest = _params as GatewayAuthRequest;
      return;
    }
    throw new Error("Method not implemented.");
  }

  async logout(_params: LogoutRequest): Promise<LogoutResponse | void> {
    if (process.env.FORK_AUTH_PROBE === "1") {
      process.stderr.write("[auth-probe] logout dispatched by the client\n");
    }
    this.gatewayAuthRequest = undefined;
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const sessionRecord = this.sessions[params.sessionId];
    if (!sessionRecord) {
      throw new Error("Session not found");
    }
    if (sessionRecord.engine?.isDisposed) {
      throw new Error(
        `session engine disposed — the claude PTY for session ${params.sessionId} has exited; ` +
          "reload or recreate the session to continue",
      );
    }

    sessionRecord.hadUserPrompt = true;
    if (this.turnInFlight(sessionRecord)) {
      if (isSendNowMeta(params._meta)) {
        return this.steerIntoTurn(params, sessionRecord);
      }
      return this.enqueuePrompt(params, sessionRecord);
    }
    return this.executePrompt(params, sessionRecord);
  }

  private turnInFlight(session: Session): boolean {
    return session.turnDetector !== undefined || session.turnCancel !== undefined;
  }

  private enqueuePrompt(params: PromptRequest, session: Session): Promise<PromptResponse> {
    return new Promise((resolve, reject) => {
      session.queuedPrompts ??= [];
      session.queuedPrompts.push({ params, resolve, reject });
    });
  }

  private async executePrompt(params: PromptRequest, session: Session): Promise<PromptResponse> {
    session.cancelled = false;
    session.currentPromptId = promptIdFromMeta(params._meta);
    try {
      return await this.runPrompt(params, session);
    } finally {
      session.currentPromptId = undefined;
      this.drainQueuedPrompt(session);
    }
  }

  private drainQueuedPrompt(session: Session): void {
    const next = session.queuedPrompts?.shift();
    if (!next || this.turnInFlight(session)) return;
    void this.executePrompt(next.params, session).then(next.resolve, next.reject);
  }

  private steerIntoTurn(params: PromptRequest, session: Session): PromptResponse {
    const turnTemp = session.turnTempImagePaths ?? [];
    session.turnTempImagePaths = turnTemp;
    const outgoing = promptToClaude(params, this.logger, turnTemp);
    if (!outgoing.trim()) {
      throw RequestError.invalidParams(undefined, "steer text is required");
    }
    session.pendingInterjectTexts ??= [];
    session.pendingInterjectTexts.push(outgoing);
    sendPrompt(session.pty, outgoing, this.schedule, "steer");
    return { stopReason: "end_turn" };
  }

  private async runPrompt(params: PromptRequest, sessionRecord: Session): Promise<PromptResponse> {
    const turnTempImagePaths: string[] = [];
    sessionRecord.turnTempImagePaths = turnTempImagePaths;
    const payload = promptToClaude(params, this.logger, turnTempImagePaths);
    const slash = parseSlashPrompt(payload);
    if (slash && isAdvertisedSlash(slash.name)) {
      try {
        return await this.replyToSlash(params.sessionId, sessionRecord, slash.name, slash.args);
      } finally {
        cleanupMaterializedImages(sessionRecord.turnTempImagePaths);
        sessionRecord.turnTempImagePaths = undefined;
      }
    }

    const outgoing = payload;

    const { detector, promise, cancel } = createTurnResolver({
      schedule: this.schedule,
      sessionId: params.sessionId,
      logger: this.logger,
      onTurnResolved: () => void this.emitSessionTitleUpdate(params.sessionId),
    });
    sessionRecord.turnDetector = detector;
    sessionRecord.turnCancel = cancel;
    detector.beginTurn();

    try {
      sendPrompt(sessionRecord.pty, outgoing, this.schedule);
    } catch (e) {
      detector.markCancelled();
      sessionRecord.turnDetector = undefined;
      sessionRecord.turnCancel = undefined;
      cleanupMaterializedImages(sessionRecord.turnTempImagePaths);
      sessionRecord.turnTempImagePaths = undefined;
      throw e;
    }

    try {
      return await promise;
    } finally {
      sessionRecord.turnDetector = undefined;
      sessionRecord.turnCancel = undefined;
      cleanupMaterializedImages(sessionRecord.turnTempImagePaths);
      sessionRecord.turnTempImagePaths = undefined;
      sessionRecord.subagentWatcher?.stop();
      sessionRecord.subagentWatcher = undefined;
      this.flushPendingControlInjections(params.sessionId, sessionRecord);
    }
  }

  private slashView(session: Session): SlashSessionView {
    const modelOpt = session.configOptions.find((o) => o.id === "model");
    const effortOpt = session.configOptions.find((o) => o.id === "effort");
    const models =
      modelOpt && "options" in modelOpt && Array.isArray(modelOpt.options)
        ? modelOpt.options.flatMap((group) =>
            "options" in group ? group.options.map((o) => o.value) : [group.value],
          )
        : [];
    const effortLevels =
      effortOpt && "options" in effortOpt && Array.isArray(effortOpt.options)
        ? effortOpt.options.flatMap((group) =>
            "options" in group ? group.options.map((o) => o.value) : [group.value],
          )
        : [];
    const model = this.currentModel(session);
    const modelDisplayName =
      session.modelInfos.find((info) => info.value === model)?.displayName ?? model;
    return {
      cwd: session.clientCwd || session.cwd,
      model,
      modelDisplayName,
      mode: session.modes.currentModeId,
      effort: this.currentEffort(session) ?? "default",
      fast: session.fastModeOn ?? false,
      models,
      effortLevels,
      contextUsed: session.lastContextUsed,
      contextSize: session.contextWindowSize,
      usage: session.accumulatedUsage,
      costUsd: session.lastCostUsd,
      mcpServers: mcpServerNames(session.mcpServers),
      additionalDirectories: session.additionalDirectories ?? [],
      startedAtMs: session.startedAtMs,
    };
  }

  private async loadPlanUsage(): Promise<PlanUsageView | undefined> {
    try {
      return await this.getPlanUsage();
    } catch (error) {
      this.logger.error("[acp-agent] plan usage fetch failed:", error);
      return undefined;
    }
  }

  private async replyToSlash(
    sessionId: string,
    session: Session,
    name: string,
    args: string,
  ): Promise<PromptResponse> {
    const view = this.slashView(session);
    if (name === "usage") view.plan = await this.loadPlanUsage();
    const result = dispatchSlash(name, args, view);
    if (result.kind === "rename") {
      try {
        const title = await this.applySessionTitle(sessionId, result.title);
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `renamed: ${title}` },
          },
        });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        });
      }
      return { stopReason: "end_turn" };
    }
    if (result.kind === "config") {
      try {
        await this.setSessionConfigOption({
          sessionId,
          configId: result.configId,
          value: result.value,
        });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        });
        return { stopReason: "end_turn" };
      }
    }
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: result.text },
      },
    });
    if (name === "usage" || name === "context") {
      await this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "usage_update",
          used: session.lastContextUsed,
          size: session.contextWindowSize,
          ...(typeof session.lastCostUsd === "number"
            ? { cost: { amount: session.lastCostUsd, currency: "USD" } }
            : {}),
        },
      });
    }
    return { stopReason: "end_turn" };
  }

  private async emitSessionTitleUpdate(sessionId: string): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) return;
    try {
      const info = await this.getSessionInfo(sessionId, { dir: session.cwd });
      if (!info) return;
      const title = sanitizeTitle(info.summary);
      if (!title || title === session.lastEmittedTitle) return;
      session.lastEmittedTitle = title;
      const updatedAt = isoLastModified(info.lastModified);
      await this.client.sessionUpdate({
        sessionId,
        update: updatedAt
          ? { sessionUpdate: "session_info_update", title, updatedAt }
          : { sessionUpdate: "session_info_update", title },
      });
    } catch (err) {
      this.logger.error("[acp-agent] session title push (#812) failed:", err);
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const sessionRecord = this.sessions[params.sessionId];
    if (!sessionRecord) {
      return;
    }

    const hadInFlightTurn = sessionRecord.turnCancel !== undefined;
    sessionRecord.cancelled = true;
    sessionRecord.turnCancel?.();
    sessionRecord.permissionAbort?.abort();

    if (sessionRecord.compactionLive) {
      await this.publishGrokExt(grokAutoCompactCancelled(params.sessionId));
      if (clientSupportsCompaction(this.clientCapabilities)) {
        await this.client.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "compaction_update",
            compactionId: sessionRecord.compactionLive.id,
            status: "cancelled",
          },
        });
      }
      sessionRecord.compactionLive = undefined;
    }

    if (!hadInFlightTurn) {
      return;
    }
    const engine = sessionRecord.engine;
    if (!engine || engine.isDisposed) {
      return;
    }
    engine.interrupt();
    this.schedule(() => {
      if (engine.isDisposed) return;
      engine.escape();
    }, this.cancelEscalationMs);
  }

  private async teardownSession(sessionId: string): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) {
      return;
    }
    const queued = session.queuedPrompts ?? [];
    session.queuedPrompts = [];
    for (const item of queued) {
      item.reject(RequestError.resourceNotFound(sessionId));
    }
    await this.cancel({ sessionId });
    cleanupMaterializedImages(session.turnTempImagePaths);
    session.turnTempImagePaths = undefined;
    session.subagentWatcher?.stop();
    session.subagentWatcher = undefined;
    session.settingsManager.dispose();
    if (session.engine) {
      session.engine.kill();
    } else {
      try {
        session.pty.kill();
      } catch {
      }
      session.watcher?.stop();
    }
    if (session.gate) {
      await session.gate.teardown();
    }
    if (session.mcpConfigFile) {
      await removeMcpScratch(session.mcpConfigFile);
    }
    if (session.appendSystemPromptFile) {
      await removeAppendSystemPromptFile(session.appendSystemPromptFile);
    }
    this.engines.delete(sessionId);
    delete this.sessions[sessionId];
  }

  async dispose(): Promise<void> {
    this.unsubMod();
    this.gatewayAuthRequest = undefined;
    const unused = Object.entries(this.sessions)
      .filter(([, session]) => isUnusedBlankSession(session))
      .map(([sessionId]) => sessionId);
    await Promise.all(Object.keys(this.sessions).map((id) => this.teardownSession(id)));
    await Promise.all(unused.map((sessionId) => this.deleteStoredSession(sessionId)));
  }

  async setSessionTitle(params: SetSessionTitleRequest): Promise<SetSessionTitleResponse> {
    const session = this.sessions[params.sessionId];
    const title = await this.applySessionTitle(params.sessionId, params.title, {
      dir: session?.cwd,
    });
    return { title };
  }

  async handleGrokSessionRename(params: GrokSessionRenameParams): Promise<Record<string, never>> {
    if (params.resetToAuto) {
      throw RequestError.invalidParams(undefined, "resetToAuto is not supported");
    }
    if (!params.sessionId) {
      throw RequestError.invalidParams(undefined, "sessionId is required");
    }
    const session = this.sessions[params.sessionId];
    const dir = session?.cwd ?? (params.cwd ? this.tuiCwdFor(params.cwd) : undefined);
    await this.applySessionTitle(params.sessionId, params.title, { dir });
    return {};
  }

  async handleGrokInterject(params: GrokInterjectParams): Promise<{ result: { status: string } }> {
    const session = this.sessions[params.sessionId];
    if (!session) throw RequestError.resourceNotFound(params.sessionId);
    if (!session.turnDetector && !session.turnCancel) {
      throw RequestError.invalidParams(undefined, "no turn in progress");
    }
    if (session.engine?.isDisposed) {
      throw RequestError.invalidParams(undefined, "session engine disposed");
    }

    const turnTemp = session.turnTempImagePaths ?? [];
    session.turnTempImagePaths = turnTemp;
    const promptBlocks: PromptRequest["prompt"] =
      params.content && params.content.length > 0
        ? params.content
        : [{ type: "text", text: params.text }];
    const outgoing = promptToClaude(
      { sessionId: params.sessionId, prompt: promptBlocks },
      this.logger,
      turnTemp,
    );
    if (!outgoing.trim()) {
      throw RequestError.invalidParams(undefined, "interject text is required");
    }

    session.pendingInterjectTexts ??= [];
    session.pendingInterjectTexts.push(outgoing);
    sendPrompt(session.pty, outgoing, this.schedule, "steer");
    return grokExtSuccess({ status: "queued" });
  }

  async handleGrokSessionInfo(params: GrokSessionIdParams): Promise<{ result: Record<string, unknown> }> {
    const session = this.sessions[params.sessionId];
    if (!session) throw RequestError.resourceNotFound(params.sessionId);
    await this.refreshContextSnapshot(params.sessionId, session);
    const model = this.currentModel(session);
    const modelDisplayName =
      session.modelInfos.find((info) => info.value === model)?.displayName ?? model;
    return grokExtSuccess(grokSessionInfo(params.sessionId, session, model, modelDisplayName));
  }

  private async refreshContextSnapshot(sessionId: string, session: Session): Promise<void> {
    const existing = this.lookupContextSnapshot(sessionId, session);
    if (existing) this.applyContextSnapshot(session, existing);
    if (!session.engine || session.engine.isDisposed) return;
    if (session.turnDetector) return;
    const beforeKey = existing ? JSON.stringify(existing) : "";
    sendPrompt(session.pty, "/context", this.schedule);
    const deadline = Date.now() + (existing ? 1_500 : 8_000);
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => this.schedule(resolve, 80));
      const snap = latestContextUsageFromTranscript(sessionId);
      if (snap && JSON.stringify(snap) !== beforeKey) {
        this.applyContextSnapshot(session, snap);
        return;
      }
    }
  }

  private lookupContextSnapshot(
    sessionId: string,
    session: Session,
  ): ContextUsageSnapshot | undefined {
    return (
      session.lastContextSnapshot ??
      (latestContextUsage(session.lastMessages) as ContextUsageSnapshot | undefined) ??
      latestContextUsageFromTranscript(sessionId)
    );
  }

  private applyContextSnapshot(session: Session, snap: ContextUsageSnapshot): void {
    session.lastContextSnapshot = snap;
    const used = typeof snap.total_tokens === "number" ? snap.total_tokens : undefined;
    if (typeof used === "number" && used > 0) session.lastContextUsed = used;
    const size = typeof snap.raw_max_tokens === "number" ? snap.raw_max_tokens : undefined;
    if (typeof size === "number" && size > 0) session.contextWindowSize = size;
  }

  async handleGrokSessionUsage(params: GrokSessionIdParams): Promise<{ usage: Record<string, unknown> }> {
    const session = this.sessions[params.sessionId];
    if (!session) throw RequestError.resourceNotFound(params.sessionId);
    return { usage: grokPromptUsage(session) };
  }

  private async applySessionTitle(
    sessionId: string,
    rawTitle: string,
    options?: { dir?: string },
  ): Promise<string> {
    const title = sanitizeTitle(rawTitle);
    if (!title) {
      throw RequestError.invalidParams(undefined, "title must not be blank");
    }
    const session = this.sessions[sessionId];
    try {
      await this.renameStoredSession(sessionId, title, options?.dir ? { dir: options.dir } : undefined);
    } catch (error) {
      if (!session) {
        throw RequestError.resourceNotFound(sessionId);
      }
      this.logger.error("[acp-agent] renameSession persist failed:", error);
    }
    if (session && title !== session.lastEmittedTitle) {
      session.lastEmittedTitle = title;
      await this.client.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "session_info_update", title },
      });
    }
    return title;
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }
    const discard = isUnusedBlankSession(session);
    await this.teardownSession(params.sessionId);
    if (discard) await this.deleteStoredSession(params.sessionId);
    return {};
  }

  async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    if (this.sessions[params.sessionId]) {
      await this.teardownSession(params.sessionId);
    }
    await this.deleteStoredSession(params.sessionId);
    return {};
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }

    await this.applySessionMode(params.sessionId, params.modeId);
    await this.driveModeIntoTui(params.sessionId, session, params.modeId);
    await this.updateConfigOption(params.sessionId, "mode", params.modeId);
    return {};
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }
    if (params.configId === FAST_MODE_CONFIG_ID) {
      const enabled = resolveFastModeEnabled(params.value);
      this.applyFastModeChange(session, enabled);
      session.configOptions = session.configOptions.map((o) =>
        o.id === FAST_MODE_CONFIG_ID
          ? o.type === "boolean"
            ? { ...o, currentValue: enabled }
            : { ...o, currentValue: enabled ? FAST_MODE_ON : FAST_MODE_OFF }
          : o,
      );
      return { configOptions: session.configOptions };
    }
    if (params.configId === ULTRACODE_CONFIG_ID && typeof params.value === "boolean") {
      const option = session.configOptions.find((o) => o.id === ULTRACODE_CONFIG_ID);
      if (!option) {
        throw new Error(`Unknown config option: ${params.configId}`);
      }
      await this.applyUltracodeChange(params.sessionId, session, params.value);
      session.configOptions = this.rebuildConfigOptionsPreserving(
        session,
        this.currentModel(session),
      );
      return { configOptions: session.configOptions };
    }
    if (typeof params.value !== "string") {
      throw new Error(`Invalid value for config option ${params.configId}: ${params.value}`);
    }

    const option = session.configOptions.find((o) => o.id === params.configId);
    if (!option) {
      throw new Error(`Unknown config option: ${params.configId}`);
    }

    const allValues =
      "options" in option && Array.isArray(option.options)
        ? option.options.flatMap((o) => ("options" in o ? o.options : [o]))
        : [];

    if (
      params.configId === "effort" &&
      params.value === LEGACY_ULTRACODE_EFFORT_VALUE &&
      allValues.some((o) => o.value === ULTRACODE_EFFORT_LEVEL)
    ) {
      this.logger.log(
        `[ultracode] event=legacy_effort_value_mapped session=${params.sessionId} effort=${ULTRACODE_EFFORT_LEVEL}`,
      );
      this.applyEffortChange(session, ULTRACODE_EFFORT_LEVEL);
      await this.applyConfigOptionValue(
        params.sessionId,
        session,
        "effort",
        ULTRACODE_EFFORT_LEVEL,
      );
      await this.applyUltracodeChange(params.sessionId, session, true);
      session.configOptions = this.rebuildConfigOptionsPreserving(
        session,
        this.currentModel(session),
      );
      return { configOptions: session.configOptions };
    }

    let validValue = allValues.find((o) => o.value === params.value);

    if (!validValue && params.configId === "model") {
      const modelInfos: ModelInfo[] = allValues.map((o) => ({
        value: o.value,
        displayName: o.name,
        description: o.description ?? "",
      }));
      const resolved = resolveModelPreference(modelInfos, params.value);
      if (resolved) {
        validValue = allValues.find((o) => o.value === resolved.value);
      }
    }

    if (!validValue) {
      throw new Error(`Invalid value for config option ${params.configId}: ${params.value}`);
    }

    const resolvedValue = validValue.value;

    if (params.configId === "mode") {
      await this.applySessionMode(params.sessionId, resolvedValue);
      const cyclable = CYCLABLE_MODES.has(resolvedValue);
      if (cyclable) {
        await this.client.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "current_mode_update", currentModeId: resolvedValue },
        });
      }
      await this.driveModeIntoTui(params.sessionId, session, resolvedValue);
      if (!cyclable) {
        await this.client.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "current_mode_update", currentModeId: resolvedValue },
        });
      }
    }
    if (params.configId === "model") {
      this.applyModelSwitch(session, resolvedValue);
    } else if (params.configId === "effort") {
      this.applyEffortChange(session, resolvedValue);
    } else if (params.configId === "agent") {
      await this.applyAgentChange(params.sessionId, session, resolvedValue);
    } else if (params.configId === ULTRACODE_CONFIG_ID) {
      await this.applyUltracodeChange(
        params.sessionId,
        session,
        resolveUltracodeEnabled(resolvedValue),
      );
      session.configOptions = this.rebuildConfigOptionsPreserving(
        session,
        this.currentModel(session),
      );
      return { configOptions: session.configOptions };
    }

    await this.applyConfigOptionValue(params.sessionId, session, params.configId, resolvedValue);

    return { configOptions: session.configOptions };
  }

  private async driveModeIntoTui(
    sessionId: string,
    session: Session,
    target: string,
  ): Promise<void> {
    if (target === session.modes.currentModeId) return;
    if (session.turnDetector !== undefined || session.respawning) {
      throw new Error(
        "Cannot change permission mode while the session is busy (a turn is in flight or a re-spawn is underway); retry when idle",
      );
    }
    if (CYCLABLE_MODES.has(target)) {
      await this.driveCyclableMode(sessionId, session, target);
    } else {
      await this.respawnSession(sessionId, session, { permissionMode: target });
    }
  }

  private async applySessionMode(sessionId: string, modeId: string): Promise<void> {
    switch (modeId) {
      case "auto":
      case "default":
      case "acceptEdits":
      case "bypassPermissions":
      case "dontAsk":
      case "plan":
        break;
      default:
        throw new Error("Invalid Mode");
    }

    const session = this.sessions[sessionId];
    if (!session) {
      throw new Error("Session not found");
    }
    if (!session.modes.availableModes.some((mode) => mode.id === modeId)) {
      throw new Error(`Mode ${modeId} is not available in this session`);
    }

  }

  private applyModelSwitch(session: Session, alias: string): void {
    if (session.turnDetector !== undefined) {
      session.pendingModelInjection = alias;
      return;
    }
    const current = session.configOptions.find((o) => o.id === "model")?.currentValue;
    if (current === alias) return;
    this.injectModelCommand(session, alias);
  }

  private injectModelCommand(session: Session, alias: string): void {
    sendPrompt(session.pty, `/model ${alias}`, (fn) => fn());
    this.schedule(() => {
      if (session.engine?.isDisposed) return;
      session.pty.write("\r");
    }, MODEL_CONFIRM_DELAY_MS);
  }

  private flushPendingControlInjections(sessionId: string, session: Session): void {
    if (session.turnDetector !== undefined) return;
    const alias = session.pendingModelInjection;
    if (alias !== undefined) {
      session.pendingModelInjection = undefined;
      this.injectModelCommand(session, alias);
    }
    const effort = session.pendingEffortInjection;
    if (effort !== undefined) {
      session.pendingEffortInjection = undefined;
      this.injectEffortCommand(session, effort);
    }
    const fast = session.pendingFastInjection;
    if (fast !== undefined) {
      session.pendingFastInjection = undefined;
      this.injectFastCommand(session, fast);
    }
    const ultracode = session.pendingUltracodeInjection;
    if (ultracode !== undefined) {
      session.pendingUltracodeInjection = undefined;
      this.injectUltracodeCommand(sessionId, session, ultracode);
    }
  }

  private async driveCyclableMode(
    sessionId: string,
    session: Session,
    target: string,
  ): Promise<void> {
    const cyclableCount = session.modes.availableModes.filter((m) =>
      CYCLABLE_MODES.has(m.id),
    ).length;
    const maxSteps = Math.max(cyclableCount, 1) + 1;
    for (let step = 0; step < maxSteps; step++) {
      if (session.modes.currentModeId === target) return;
      const before = session.modes.currentModeId;
      session.pty.write(MODE_CYCLE_KEY);
      const observed = await this.awaitModeChange(sessionId, session, before);
      if (observed === undefined) return;
      session.modes.currentModeId = observed;
    }
  }

  private async awaitModeChange(
    sessionId: string,
    session: Session,
    before: string,
  ): Promise<string | undefined> {
    let waited = 0;
    for (;;) {
      const mode = await this.readLatestPermissionMode(sessionId, session);
      if (mode !== undefined && mode !== before) return mode;
      if (waited >= MODE_CYCLE_STEP_TIMEOUT_MS) return undefined;
      await new Promise<void>((resolve) => this.schedule(() => resolve(), MODE_CYCLE_POLL_MS));
      waited += MODE_CYCLE_POLL_MS;
    }
  }

  private async readLatestPermissionMode(
    sessionId: string,
    session: Session,
  ): Promise<string | undefined> {
    const read = this.getMessages ?? defaultGetMessages;
    const messages = await read(sessionId, { dir: session.cwd });
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as { type?: string; permissionMode?: unknown };
      if (m.type === "permission-mode" && typeof m.permissionMode === "string")
        return m.permissionMode;
    }
    return undefined;
  }

  private async respawnSession(
    sessionId: string,
    session: Session,
    change: { permissionMode?: string; effortLevel?: string; agent?: string },
  ): Promise<void> {
    const fresh = !session.interacted;
    session.respawning = true;
    try {
      const oldEngine = session.engine;
      const permissionMode = change.permissionMode ?? session.modes.currentModeId;
      const effortLevel = change.effortLevel ?? this.currentEffort(session);
      const agent = change.agent ?? this.currentAgent(session);
      if (session.mcpServers && session.mcpServers.length > 0) {
        const old = session.mcpConfigFile;
        session.mcpConfigFile = await writeMcpScratch(translateMcpServers(session.mcpServers));
        if (old) await removeMcpScratch(old);
      }
      if (session.localToolForward) {
        const translated = translateMcpServers(session.mcpServers);
        assertForwardingStdioMcp(translated);
        const coverage = await resolveForwardingCoverage(
          translated,
          session.localToolForwardMeta ?? { claudeCode: { localToolForward: true } },
        );
        session.forwardMcpServers = coverage.servers;
        const oldAppend = session.appendSystemPromptFile;
        session.appendSystemPromptFile = await writeAppendSystemPromptFile(
          buildLocalEnvironmentAppend({
            cwd: session.cwd,
            servers: coverage.servers,
          }),
        );
        if (oldAppend) await removeAppendSystemPromptFile(oldAppend);
      }
      if (fresh) {
        oldEngine?.kill();
      }
      const started = await this.startEngine({
        sessionId,
        cwd: session.cwd,
        resume: !fresh,
        inPlaceRespawn: true,
        permissionMode,
        effortLevel,
        agent,
        mcpConfigFile: session.mcpConfigFile,
        disallowedTools: session.disallowedTools,
        appendSystemPromptFile: session.appendSystemPromptFile,
        extraFlags: extraFlagsWithModel(this.relayFlags, this.currentModel(session)),
        additionalDirectories: workspaceOnClient({
          fs: this.clientCapabilities?.fs,
          environmentFile: Boolean(process.env.CC_MODS_PLUGIN_DIR && existsSync(path.join(process.env.CC_MODS_PLUGIN_DIR, ENVIRONMENT_FILE))),
        })
          ? undefined
          : session.additionalDirectories,
        sessions: this.engines,
        onEvent: (sid) => void this.pumpUpdates(sid),
      });
      if (!fresh) {
        oldEngine?.kill();
      }
      session.pty = started.pty;
      session.engine = started.engine;
      session.watcher = started.watcher;
      if (change.permissionMode) {
        session.modes = { ...session.modes, currentModeId: change.permissionMode };
      }
    } finally {
      session.respawning = false;
    }
  }

  private currentEffort(session: Session): string | undefined {
    const opt = session.configOptions.find((o) => o.id === "effort");
    return typeof opt?.currentValue === "string" ? opt.currentValue : undefined;
  }

  private currentAgent(session: Session): string | undefined {
    const opt = session.configOptions.find((o) => o.id === "agent");
    return typeof opt?.currentValue === "string" ? opt.currentValue : undefined;
  }

  private currentModel(session: Session): string {
    const opt = session.configOptions.find((o) => o.id === "model");
    return typeof opt?.currentValue === "string" ? opt.currentValue : DEFAULT_MODEL_INFO.value;
  }

  private async applyUltracodeChange(
    sessionId: string,
    session: Session,
    enabled: boolean,
  ): Promise<void> {
    if (enabled) session.ultracodeRefusal = undefined;
    if (enabled === (session.ultracodeOn ?? false)) return;
    session.ultracodeOn = enabled;
    await this.mirrorUltracodeIntoScratch(session, enabled);
    if (session.turnDetector !== undefined) {
      session.pendingUltracodeInjection = enabled;
      return;
    }
    this.injectUltracodeCommand(sessionId, session, enabled);
  }

  private async mirrorUltracodeIntoScratch(session: Session, enabled: boolean): Promise<void> {
    const scratchPath = session.gate?.settingsPath;
    if (!scratchPath) return;
    try {
      await applyUltracodeSettings(scratchPath, enabled);
    } catch (err) {
      this.logger.error(
        `[ultracode] event=scratch_write_failed enabled=${enabled} path=${scratchPath}: ${String(err)}`,
      );
    }
  }

  private injectUltracodeCommand(sessionId: string, session: Session, on: boolean): void {
    session.ultracodeReplyStop?.();
    session.ultracodeReplyStop = undefined;
    if (on) this.watchUltracodeReply(sessionId, session);
    sendPrompt(session.pty, ultracodeCommand(on), (fn) => fn());
  }

  private watchUltracodeReply(sessionId: string, session: Session): void {
    let buffer = "";
    let done = false;
    const subscription = session.pty.onData((chunk: string) => {
      if (done) return;
      buffer = (buffer + chunk).slice(-ULTRACODE_REPLY_BUFFER_CHARS);
      const reply = classifyUltracodeReply(buffer);
      if (reply.kind === "pending") return;
      stop();
      if (reply.kind === "refused") {
        this.handleUltracodeRefusal(sessionId, session, reply.reason).catch((err: unknown) =>
          this.logger.error(
            `[ultracode] event=refusal_handling_failed sessionId=${sessionId}: ${String(err)}`,
          ),
        );
      }
    });
    const stop = () => {
      if (done) return;
      done = true;
      subscription.dispose();
      cancelTimer();
      if (session.ultracodeReplyStop === stop) session.ultracodeReplyStop = undefined;
    };
    const cancelTimer = this.schedule(stop, ULTRACODE_REPLY_WINDOW_MS);
    session.ultracodeReplyStop = stop;
  }

  private async handleUltracodeRefusal(
    sessionId: string,
    session: Session,
    reason: string,
  ): Promise<void> {
    session.ultracodeOn = false;
    session.pendingUltracodeInjection = undefined;
    session.ultracodeRefusal = {
      scope: /dynamic workflows/i.test(reason) ? "workflows" : "model",
      reason,
    };
    this.logger.log(`[ultracode] event=refused sessionId=${sessionId} reason="${reason}"`);
    await this.mirrorUltracodeIntoScratch(session, false);
    if (!this.sessions[sessionId]) return;
    session.configOptions = this.rebuildConfigOptionsPreserving(
      session,
      this.currentModel(session),
    );
    await this.client.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "config_option_update", configOptions: session.configOptions },
    });
  }

  private applyEffortChange(session: Session, level: string): void {
    if (level === this.currentEffort(session)) return;
    if (session.turnDetector !== undefined) {
      session.pendingEffortInjection = level;
      return;
    }
    this.injectEffortCommand(session, level);
  }

  private injectEffortCommand(session: Session, level: string): void {
    sendPrompt(session.pty, `/effort ${level}`, (fn) => fn());
  }

  private applyFastModeChange(session: Session, enabled: boolean): void {
    if (enabled === (session.fastModeOn ?? false)) return;
    session.fastModeOn = enabled;
    if (session.turnDetector !== undefined) {
      session.pendingFastInjection = enabled;
      return;
    }
    this.injectFastCommand(session, enabled);
  }

  private injectFastCommand(session: Session, on: boolean): void {
    sendPrompt(session.pty, on ? "/fast on" : "/fast off", (fn) => fn());
    this.schedule(() => {
      if (session.engine?.isDisposed) return;
      session.pty.write("\r");
    }, MODEL_CONFIRM_DELAY_MS);
  }

  private async refreshFastMode(sessionId: string, session: Session): Promise<void> {
    const modelOpt = session.configOptions.find((o) => o.id === "model");
    const modelId =
      typeof modelOpt?.currentValue === "string" ? modelOpt.currentValue : DEFAULT_MODEL_INFO.value;

    let available: boolean;
    if (!isFastModeCapableModel(modelId)) {
      available = false;
    } else {
      try {
        available = await this.fastModeProbe({ pty: session.pty, cwd: session.cwd });
      } catch {
        available = false;
      }
    }

    const before = session.fastModeAvailable ?? false;
    session.fastModeAvailable = available;
    if (available === before) return;

    session.configOptions = this.rebuildConfigOptionsPreserving(session, modelId);
    if (!this.sessions[sessionId]) return;
    await this.client.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "config_option_update", configOptions: session.configOptions },
    });
  }

  private rebuildConfigOptionsPreserving(session: Session, modelId: string): SessionConfigOption[] {
    const effortOpt = session.configOptions.find((o) => o.id === "effort");
    const currentEffort =
      typeof effortOpt?.currentValue === "string" ? effortOpt.currentValue : undefined;
    const agentOpt = session.configOptions.find((o) => o.id === "agent");
    const currentAgent =
      typeof agentOpt?.currentValue === "string" ? agentOpt.currentValue : undefined;
    return buildConfigOptions(
      session.modes,
      modelId,
      session.modelInfos,
      currentEffort,
      session.agents ?? [],
      currentAgent,
      session.fastModeAvailable ?? false,
      session.fastModeOn ?? false,
      clientSupportsBooleanConfigOptions(this.clientCapabilities),
      { on: session.ultracodeOn ?? false, refusal: session.ultracodeRefusal?.reason },
    );
  }

  private async applyAgentChange(
    sessionId: string,
    session: Session,
    agent: string,
  ): Promise<void> {
    if (agent === (this.currentAgent(session) ?? "default")) return;
    if (session.turnDetector !== undefined || session.respawning) {
      throw new Error(
        "Cannot change agent while the session is busy (a turn is in flight or a re-spawn is underway); retry when idle",
      );
    }
    await this.respawnSession(sessionId, session, { agent });
  }

  private async reconcileModeFromTranscript(
    sessionId: string,
    session: Session,
    messages: SessionMessage[],
  ): Promise<void> {
    let latestMode: string | undefined;
    for (const m of messages) {
      const w = m as { type?: string; permissionMode?: unknown };
      if (w.type === "permission-mode" && typeof w.permissionMode === "string") {
        latestMode = w.permissionMode;
      }
    }
    if (latestMode === undefined || latestMode === session.modes.currentModeId) return;
    session.modes = { ...session.modes, currentModeId: latestMode };
    session.configOptions = session.configOptions.map((o) =>
      o.id === "mode" && typeof o.currentValue === "string"
        ? { ...o, currentValue: latestMode }
        : o,
    );
    await this.client.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "current_mode_update", currentModeId: latestMode },
    });
  }

  private async readSessionMessages(sessionId: string, dir: string | undefined): Promise<SessionMessage[]> {
    return withPrecompactHistory(
      sessionId,
      await readOrderedMessages(sessionId, dir, { getMessages: this.getMessages }),
      this.precompactOptions,
    );
  }

  private async wait(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve) => this.schedule(resolve, ms));
  }

  private async readReplayMessages(sessionId: string, session: Session): Promise<SessionMessage[]> {
    let messages = await this.readSessionMessages(sessionId, session.cwd);
    if (!session.forkedFrom) return messages;

    const needed = session.forkInheritCount ?? 0;
    if (needed > 0 && replayableTurnCount(messages) < needed && this.forkHistoryWaitMs > 0) {
      const deadline = Date.now() + this.forkHistoryWaitMs;
      while (Date.now() < deadline && replayableTurnCount(messages) < needed) {
        await this.wait(FORK_HISTORY_POLL_MS);
        messages = await this.readSessionMessages(sessionId, session.cwd);
      }
    }

    if (replayableTurnCount(messages) > 0) return messages;

    const parent = this.sessions[session.forkedFrom];
    if (parent?.lastMessages && replayableTurnCount(parent.lastMessages) > 0) {
      return withPrecompactHistory(session.forkedFrom, parent.lastMessages, this.precompactOptions);
    }
    try {
      return await this.readSessionMessages(session.forkedFrom, session.cwd);
    } catch (error) {
      this.logger.error("[acp-agent] fork history fallback failed:", error);
      return messages;
    }
  }

  private async replaySessionHistory(
    sessionId: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) return;
    if (opts.force) {
      session.emitted.clear();
      session.emittedNested.clear();
    }
    const messages = await this.readReplayMessages(sessionId, session);
    session.lastMessages = messages;
    await this.emitLinearizedWithNested(sessionId, session, messages);
  }

  private async emitTurnUpdates(
    sessionId: string,
    turn: { message: unknown },
    toolUseCache: ToolUseCache,
    live: boolean = false,
  ): Promise<void> {
    const session = this.sessions[sessionId];
    if (isCompactSummaryMessage(turn.message)) return;
    const source = turn.message as { message?: { role?: string; content?: unknown } };
    let role = source.message?.role;
    let content: unknown = source.message?.content;
    if (role === "user" && session && consumePendingInterject(session, content)) {
      return;
    }
    if (role === "user") {
      const status = statusCommandOutput(content);
      if (status !== null) {
        role = "assistant";
        content = status;
      } else {
        content = stripLocalCommandMetadata(content);
        if (content === null) return;
      }
    }

    const turnToolUseResult = (turn.message as { toolUseResult?: unknown }).toolUseResult;

    for (const notification of toAcpNotifications(
      // @ts-expect-error - message.content/role are untyped in the reduced SDK shape
      content,
      role,
      sessionId,
      toolUseCache,
      this.client,
      this.logger,
      {
        registerHooks: false,
        clientCapabilities: this.clientCapabilities,
        cwd: session?.cwd,
        taskState: session?.taskState,
        toolUseResult: turnToolUseResult,
        background: {
          ended: (id) => session?.backgroundTaskEnds?.get(id),
          held: live && session ? (session.heldBackgroundExits ??= new Set()) : undefined,
        },
      },
    )) {
      await this.client.sessionUpdate(notification);
    }

    const toolUseResult = (turn.message as { toolUseResult?: unknown }).toolUseResult;
    if (toolUseResult !== undefined && Array.isArray(content)) {
      for (const block of content) {
        if (
          block !== null &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "tool_result" &&
          typeof (block as { tool_use_id?: unknown }).tool_use_id === "string"
        ) {
          const toolCallId = (block as { tool_use_id: string }).tool_use_id;
          const name = toolUseCache[toolCallId]?.name;
          const diffUpdate = diffToolCallUpdate(
            classifyDiffSource(name, toolUseResult),
            toolCallId,
          );
          if (diffUpdate) {
            await this.client.sessionUpdate({
              sessionId,
              update: diffUpdate as unknown as SessionNotification["update"],
            });
          }
        }
      }
    }

    if (session && !session.usageDisabled) {
      const turnRecord = turn.message as { total_cost_usd?: number; message?: unknown };
      const carrier = {
        ...((turnRecord.message ?? {}) as UsageCarrier),
        ...(typeof turnRecord.total_cost_usd === "number"
          ? { total_cost_usd: turnRecord.total_cost_usd }
          : {}),
      };
      const realModel = carrier.model;
      if (typeof realModel === "string" && realModel.length > 0) {
        session.contextWindowSize =
          inferContextWindowFromModelId(realModel) ?? session.contextWindowSize;
      }
      session.accumulatedUsage = addUsage(session.accumulatedUsage, carrier.usage);
      if (typeof carrier.total_cost_usd === "number") session.lastCostUsd = carrier.total_cost_usd;
      for (const usageUpdate of usageUpdatesFor(carrier, {
        usageUpdate: this.usageUpdate,
        contextWindowSize: session.contextWindowSize,
      })) {
        session.lastContextUsed = usageUpdate.used;
        try {
          await this.client.sessionUpdate({
            sessionId,
            update: usageUpdate as unknown as SessionNotification["update"],
          });
        } catch (err) {
          session.usageDisabled = true;
          this.logger.error(
            `usage_update rejected by client (R8) — suppressing further usage_update for session ${sessionId}: ${String(err)}`,
          );
          break;
        }
      }
    }

    if (session) {
      const modelCarrier = (turn.message as { message?: unknown }).message ?? {};
      await this.reconcileModelSelector(
        sessionId,
        session,
        (modelCarrier as { model?: unknown }).model,
      );
    }
  }

  private async reconcileModelSelector(
    sessionId: string,
    session: Session,
    rawModel: unknown,
  ): Promise<void> {
    if (typeof rawModel !== "string" || rawModel.length === 0) return;
    const resolved = resolveCatalogValueFromModelId(rawModel);
    if (resolved === null) return;

    const modelOpt = session.configOptions.find((o) => o.id === "model");
    const current = typeof modelOpt?.currentValue === "string" ? modelOpt.currentValue : undefined;
    if (current === undefined) return;

    const family = (v: string): string => (v === "default" ? "opus" : v);
    if (family(current) === family(resolved)) return;

    session.configOptions = this.rebuildConfigOptionsPreserving(session, resolved);
    if (!this.sessions[sessionId]) return;
    await this.client.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "config_option_update", configOptions: session.configOptions },
    });
  }

  private nestedUpdatesFor(
    sessionId: string,
    message: SessionMessage,
    toolUseCache: ToolUseCache,
  ): SessionNotification[] {
    const parentId = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
    if (typeof parentId !== "string" || parentId.length === 0) return [];

    const session = this.sessions[sessionId];
    const source = (message as { message?: { role?: string; content?: unknown } }).message;
    const role = source?.role === "user" ? "user" : "assistant";
    const content = source?.content;
    if (content === undefined || content === null) return [];

    const translated = toAcpNotifications(
      // @ts-expect-error - message.content/role are untyped in the reduced SDK shape
      content,
      role,
      sessionId,
      toolUseCache,
      this.client,
      this.logger,
      {
        registerHooks: false,
        clientCapabilities: this.clientCapabilities,
        cwd: session?.cwd,
        taskState: session?.taskState,
        toolUseResult: (message as { toolUseResult?: unknown }).toolUseResult,
      },
    );

    const out: SessionNotification[] = [];
    for (const notification of translated) {
      const nestedContent = this.toNestedContent(notification.update);
      if (nestedContent.length === 0) continue;
      out.push({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: parentId,
          content: nestedContent,
          _meta: { claudeCode: { parentToolUseId: parentId } },
        } as unknown as SessionNotification["update"],
      });
    }
    return out;
  }

  private toNestedContent(update: SessionNotification["update"]): ToolCallContent[] {
    const u = update as {
      sessionUpdate?: string;
      content?: unknown;
      title?: unknown;
    };
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
      case "user_message_chunk":
      case "agent_thought_chunk":
        return u.content ? [{ type: "content", content: u.content } as ToolCallContent] : [];
      case "tool_call":
      case "tool_call_update": {
        const acc: ToolCallContent[] = [];
        if (typeof u.title === "string" && u.title.length > 0) {
          acc.push({
            type: "content",
            content: { type: "text", text: `**${u.title}**` },
          } as ToolCallContent);
        }
        if (Array.isArray(u.content)) {
          for (const item of u.content) acc.push(item as ToolCallContent);
        }
        return acc;
      }
      default:
        return [];
    }
  }

  async handleModEvent(event: ModEvent): Promise<void> {
    const sessionId =
      Object.entries(this.sessions).find(([, session]) => session.turnDetector)?.[0] ??
      Object.keys(this.sessions)[0];
    if (!sessionId) return;
    const session = this.sessions[sessionId];
    if (!session) return;
    if (event.type === "permission_request" && typeof event.requestId === "string") {
      const holdId = `perm:${event.requestId}`;
      session.turnDetector?.hold(holdId);
      try {
        await this.bridgePermission(sessionId, event);
      } finally {
        session.turnDetector?.release(holdId);
      }
      return;
    }
    if (event.type === "ask_question" && typeof event.requestId === "string") {
      const holdId = `ask:${event.requestId}`;
      session.turnDetector?.hold(holdId);
      try {
        await this.bridgeQuestion(sessionId, event);
      } finally {
        session.turnDetector?.release(holdId);
      }
      return;
    }
    if (event.type === "plugin_error") {
      this.logger.error("[mod-live] plugin error:", event.message ?? event);
      return;
    }
    // Mods is the live path: JSONL is not observed for EOT while the plugin is
    // connected, so every live event must keep the stall watchdog from firing.
    const toolUseId = typeof event.toolUseId === "string" ? event.toolUseId : undefined;
    if (event.type === "tool_started" && toolUseId) session.turnDetector?.hold(toolUseId);
    else if (event.type === "tool_finished" && toolUseId) session.turnDetector?.release(toolUseId);
    else session.turnDetector?.noteActivity();
    if (event.type === "tool_started" || event.type === "tool_finished") {
      debug(`mod ${event.type}`, {
        toolUseId: event.toolUseId,
        tool: event.tool,
        isError: event.isError,
        input: event.input,
        result: event.result,
      });
    }
    session.modTools ??= new Map();
    const kind = await applyModEvent(sessionId, event, {
      client: this.client,
      tools: session.modTools,
      cwd: session.cwd,
      supportsTerminal: (this.clientCapabilities?._meta as { terminal_output?: boolean } | undefined)?.terminal_output === true,
      contextWindowSize: session.contextWindowSize,
    });
    if (event.type === "usage") {
      const counts = {
        input_tokens: typeof event.inputTokens === "number" ? event.inputTokens : null,
        output_tokens: typeof event.outputTokens === "number" ? event.outputTokens : null,
        cache_read_input_tokens: typeof event.cachedReadTokens === "number" ? event.cachedReadTokens : null,
        cache_creation_input_tokens:
          typeof event.cachedWriteTokens === "number" ? event.cachedWriteTokens : null,
      };
      session.accumulatedUsage = addUsage(session.accumulatedUsage, counts);
      const used = contextTokensUsed(counts);
      if (used !== undefined) session.lastContextUsed = used;
    }
    if (kind === "turn_started") {
      session.liveFromMod = true;
      session.turnDetector?.noteActivity();
    }
    if (kind === "turn_completed") {
      if (event.reason === "aborted" || event.isAborted === true) session.turnCancel?.();
      else session.turnDetector?.finish(stopReasonFromMod(event.reason));
    }
  }

  private async bridgePermission(sessionId: string, event: ModEvent): Promise<void> {
    const requestId = String(event.requestId);
    const tool = typeof event.tool === "string" ? event.tool : "tool";
    const input = (event.input && typeof event.input === "object" ? event.input : {}) as Record<string, unknown>;
    const toolCallId = typeof event.toolUseId === "string" ? event.toolUseId : requestId;
    const session = this.sessions[sessionId];
    const info = toolInfoFromToolUse({ id: toolCallId, name: tool, input }, false, session?.cwd);
    let decision: PermissionDecision = "reject";
    if (!session) {
      answerPermission(requestId, decision);
      return;
    }
    const abort = new AbortController();
    session.permissionAbort = abort;
    try {
      if (abort.signal.aborted) {
        decision = "reject";
      } else {
        const res = await Promise.race([
          this.client.requestPermission({
            sessionId,
            toolCall: {
              toolCallId,
              title: info.title,
              kind: info.kind,
              rawInput: input,
            },
            options: [
              { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
              { optionId: "allow-with-updates", name: "Always allow", kind: "allow_always" },
              { optionId: "reject", name: "Reject", kind: "reject_once" },
            ],
          }),
          abortedPermission(abort.signal),
        ]);
        const optionId = res.outcome.outcome === "selected" ? res.outcome.optionId : undefined;
        decision =
          optionId === "allow-once" || optionId === "allow"
            ? "allow_once"
            : optionId === "allow-with-updates"
              ? "allow_with_updates"
              : "reject";
      }
    } catch (err) {
      this.logger.error("[mod-live] request_permission failed:", err);
    } finally {
      if (session.permissionAbort === abort) session.permissionAbort = undefined;
    }
    answerPermission(requestId, decision);
  }

  private async bridgeQuestion(sessionId: string, event: ModEvent): Promise<void> {
    const requestId = String(event.requestId);
    const questions = asAskQuestions(event.questions);
    let answers: Record<string, string> | null = null;
    if (this.clientSupportsElicitationForm && questions.length) {
      try {
        const res = await this.client.createElicitation({
          mode: "form",
          sessionId,
          message: "Claude has a question",
          requestedSchema: questionForm(questions),
        } as CreateElicitationRequest);
        if ((res as { action?: string }).action === "accept") {
          answers = formAnswers(questions, (res as { content?: Record<string, unknown> }).content);
        }
      } catch (err) {
        this.logger.error("[mod-live] elicitation failed:", err);
      }
    }
    answerQuestion(requestId, answers);
  }

  private async pumpUpdates(sessionId: string): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) return;

    session.interacted = true;
    if (session.liveFromMod || modChannelConnected()) {
      const messages = await readOrderedMessages(sessionId, session.cwd, {
        getMessages: this.getMessages,
      });
      const fed = messages.slice(session.detectorCursor ?? 0);
      session.detectorCursor = messages.length;
      if (session.turnDetector) {
        for (const m of fed) {
          session.turnDetector.observe(m as never);
          const content = (m as { message?: { content?: unknown } }).message?.content;
          if (statusCommandOutput(content)) session.turnDetector.finish("end_turn");
        }
      }
      if (session.gate) {
        for (const m of fed) registerGateToolUses(m, session.gate);
      }
      session.lastMessages = messages;
      await this.emitCompactionSignals(sessionId, session, messages, true);
      return;
    }

    const messages = await readOrderedMessages(sessionId, session.cwd, {
      getMessages: this.getMessages,
    });

    if (!session.guardChecked) {
      session.guardChecked = true;
      const firstBilling = messages.find((m) => {
        const w = m as WatchedMessage;
        return (
          (w.type === "assistant" || w.type === "user") &&
          typeof w.entrypoint === "string" &&
          w.entrypoint.length > 0
        );
      });
      if (firstBilling) {
        let aborted = false;
        guardEvent(firstBilling as WatchedMessage, {
          alert: (m) => this.logger.error(m),
          stopSession: () => {
            aborted = true;
          },
        });
        if (aborted) {
          await this.teardownSession(sessionId);
          return;
        }
      }
    }

    const fed = messages.slice(session.detectorCursor ?? 0);
    session.detectorCursor = messages.length;
    if (session.turnDetector) {
      for (const m of fed) {
        session.turnDetector.observe(m as never);
        const content = (m as { message?: { content?: unknown } }).message?.content;
        if (statusCommandOutput(content)) session.turnDetector.finish("end_turn");
      }
    }

    if (session.gate) {
      for (const m of fed) registerGateToolUses(m, session.gate);
    }

    await this.reconcileModeFromTranscript(sessionId, session, fed);

    await this.emitLinearizedWithNested(sessionId, session, messages, true);
    await this.flushBackgroundExits(sessionId, session);

    if (session.gate && !session.gate.isTorndown) {
      const subagentRows = await sourceSubagentRows(sessionId, messages, {
        dir: session.cwd,
        listSubagents: this.listSubagents,
        getSubagentMessages: this.getSubagentMessages,
      });
      session.registeredSidechain ??= new Set<string>();
      session.sidechainParentMap ??= new Map<string, SidechainToolUse>();
      registerSidechainGateToolUses(
        collectSidechainToolUses(subagentRows),
        session.gate.correlator,
        session.registeredSidechain,
        session.sidechainParentMap,
      );
    }

    session.lastMessages = messages;
    if (this.liveSubagentWatch) {
      if (!session.subagentWatcher && hasSubagentSpawn(messages) && spawnIdsOpen(messages)) {
        session.subagentWatcher = createSubagentWatcher({
          sessionId,
          dir: session.cwd,
          mainChain: messages,
          listSubagents: this.listSubagents,
          getSubagentMessages: this.getSubagentMessages,
          schedule: this.schedule,
          onActivity: async () => {
            session.turnDetector?.noteActivity();
            await this.emitLinearizedWithNested(
              sessionId,
              session,
              session.lastMessages ?? messages,
              true,
            );
          },
        });
      } else if (session.subagentWatcher) {
        session.subagentWatcher.update(messages);
        if (!spawnIdsOpen(messages)) {
          session.subagentWatcher.stop();
          session.subagentWatcher = undefined;
        }
      }
    }
  }

  private async flushBackgroundExits(sessionId: string, session: Session): Promise<void> {
    const held = session.heldBackgroundExits;
    if (!held?.size) return;
    for (const terminalId of [...held]) {
      const end = session.backgroundTaskEnds?.get(terminalId);
      if (!end) continue;
      held.delete(terminalId);
      await this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: terminalId,
          _meta: {
            terminal_exit: { terminal_id: terminalId, exit_code: end.exitCode, signal: null },
          } satisfies ToolUpdateMeta,
        },
      });
    }
  }

  private async emitCompactionSignals(
    sessionId: string,
    session: Session,
    messages: SessionMessage[],
    live: boolean,
  ): Promise<void> {
    session.emittedCompaction ??= new Set();
    for (const message of messages) {
      const event = compactEventFromMessage(message);
      if (!event) continue;
      if (session.emittedCompaction.has(event.uuid)) continue;
      session.emittedCompaction.add(event.uuid);
      await this.publishCompactEvent(sessionId, session, event, live);
    }
  }

  private async publishCompactEvent(
    sessionId: string,
    session: Session,
    event: CompactEvent,
    live: boolean,
  ): Promise<void> {
    const window = session.contextWindowSize || DEFAULT_CONTEXT_WINDOW;
    if (event.kind === "boundary") {
      const tokensUsed = event.tokensBefore ?? session.lastContextUsed;
      const tokensAfter = event.tokensAfter ?? session.lastContextUsed;
      const percentage = compactPercentage(tokensUsed, window);
      session.compactionLive = {
        id: event.uuid,
        tokensBefore: event.tokensBefore,
        startedAt: Date.now(),
      };
      if (live) {
        await this.publishGrokExt(
          grokAutoCompactStarted({
            sessionId,
            tokensUsed,
            contextWindow: window,
            percentage,
            reason:
              event.trigger === "manual"
                ? "Manual compact"
                : `Context window ${percentage}% full`,
          }),
        );
      }
      await this.publishGrokExt(
        grokAutoCompactCompleted({
          sessionId,
          tokensBefore: event.tokensBefore,
          tokensAfter,
          summaryPreview: undefined,
        }),
      );
      if (event.tokensAfter !== undefined) session.lastContextUsed = event.tokensAfter;
      if (clientSupportsCompaction(this.clientCapabilities)) {
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "compaction_update",
            compactionId: event.uuid,
            status: live ? "in_progress" : "completed",
          },
        });
      }
      return;
    }

    const compactionId = session.compactionLive?.id ?? event.uuid;
    const hadBoundary = session.compactionLive !== undefined;
    session.compactionLive = undefined;
    if (!hadBoundary) {
      await this.publishGrokExt(
        grokAutoCompactCompleted({
          sessionId,
          tokensAfter: session.lastContextUsed,
          summaryPreview: event.text.slice(0, 100) || undefined,
        }),
      );
    }
    await this.publishGrokExt(grokCompactionSummary(sessionId, event.text));
    if (clientSupportsCompaction(this.clientCapabilities)) {
      await this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "compaction_update",
          compactionId,
          status: "completed",
          summary: [{ type: "text", text: event.text }],
        },
      });
    }
  }

  private async publishGrokExt(note: {
    method: string;
    params: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.client.extNotify?.(note.method, note.params);
    } catch (err) {
      this.logger.error("[acp-agent] ext notify failed:", err);
    }
  }

  private async emitLinearizedWithNested(
    sessionId: string,
    session: Session,
    messages: SessionMessage[],
    live: boolean = false,
  ): Promise<void> {
    const subagentRows = await sourceSubagentRows(sessionId, messages, {
      dir: session.cwd,
      listSubagents: this.listSubagents,
      getSubagentMessages: this.getSubagentMessages,
    });
    const forLinearize = subagentRows.length ? messages.concat(subagentRows) : messages;

    await this.emitCompactionSignals(sessionId, session, forLinearize, live);

    for (const turn of linearizeTurns(forLinearize)) {
      if (!(turn.uuid && session.emitted.has(turn.uuid))) {
        await this.emitTurnUpdates(sessionId, turn, session.toolUseCache, live);
        if (turn.uuid) session.emitted.add(turn.uuid);
      }

      for (const nested of turn.nested ?? []) {
        const nuid = (nested as { uuid?: string }).uuid;
        if (nuid && session.emittedNested.has(nuid)) continue;
        for (const note of this.nestedUpdatesFor(sessionId, nested, session.toolUseCache))
          await this.client.sessionUpdate(note);
        if (nuid) session.emittedNested.add(nuid);
      }
    }
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const response = await this.client.readTextFile(params);
    return response;
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    const response = await this.client.writeTextFile(params);
    return response;
  }

  private async sendAvailableCommandsUpdate(sessionId: string): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) return;
    let availableCommands: AvailableCommand[];
    try {
      availableCommands = this.discoverCommands(session.cwd);
    } catch {
      availableCommands = [];
    }
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands,
      },
    });
  }

  private async updateConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) return;

    await this.applyConfigOptionValue(sessionId, session, configId, value);

    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: session.configOptions,
      },
    });
  }

  private async applyConfigOptionValue(
    sessionId: string,
    session: Session,
    configId: string,
    value: string,
  ): Promise<void> {
    if (configId === "mode") {
      session.modes = { ...session.modes, currentModeId: value };
      session.configOptions = session.configOptions.map((o) =>
        o.id === configId && typeof o.currentValue === "string" ? { ...o, currentValue: value } : o,
      );
    } else if (configId === "model") {
      const modelOption = session.configOptions.find((o) => o.id === "model");
      const previousModelId =
        typeof modelOption?.currentValue === "string" ? modelOption.currentValue : undefined;
      if (previousModelId !== value) {
        session.contextWindowSize = inferContextWindowFromModel(value) ?? DEFAULT_CONTEXT_WINDOW;
      }

      const newModelInfo = session.modelInfos.find((m) => m.value === value);
      const newAvailableModes = buildAvailableModes(
        newModelInfo,
        session.allowBypass ?? ALLOW_BYPASS,
      );
      const previousModeId = session.modes.currentModeId;
      let modeDowngraded = false;
      if (!newAvailableModes.some((m) => m.id === previousModeId)) {
        session.modes = {
          availableModes: newAvailableModes,
          currentModeId: "default",
        };
        modeDowngraded = true;
      } else {
        session.modes = { ...session.modes, availableModes: newAvailableModes };
      }

      const effortOpt = session.configOptions.find((o) => o.id === "effort");
      const currentEffort =
        typeof effortOpt?.currentValue === "string" ? effortOpt.currentValue : undefined;
      const agentOpt = session.configOptions.find((o) => o.id === "agent");
      const currentAgent =
        typeof agentOpt?.currentValue === "string" ? agentOpt.currentValue : undefined;
      if (previousModelId !== value) {
        session.fastModeOn = false;
        session.fastModeAvailable = false;
        if (session.ultracodeRefusal?.scope === "model") session.ultracodeRefusal = undefined;
      }
      session.configOptions = buildConfigOptions(
        session.modes,
        value,
        session.modelInfos,
        currentEffort,
        session.agents ?? [],
        currentAgent,
        session.fastModeAvailable ?? false,
        session.fastModeOn ?? false,
        clientSupportsBooleanConfigOptions(this.clientCapabilities),
        { on: session.ultracodeOn ?? false, refusal: session.ultracodeRefusal?.reason },
      );

      if (previousModelId !== value && isFastModeCapableModel(value)) {
        void this.refreshFastMode(sessionId, session);
      }

      if (modeDowngraded) {
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId: "default",
          },
        });
      }
    } else {
      session.configOptions = session.configOptions.map((o) =>
        o.id === configId && typeof o.currentValue === "string" ? { ...o, currentValue: value } : o,
      );
    }
  }

  private async storedSessionExists(sessionId: string, cwd: string): Promise<boolean> {
    if (this.locateTranscriptFiles(sessionId).length > 0) return true;
    try {
      const info = await this.getSessionInfo(sessionId, { dir: this.tuiCwdFor(cwd) });
      return Boolean(info);
    } catch {
      return false;
    }
  }

  private async getOrCreateSession(
    params: {
      sessionId: string;
      cwd: string;
      mcpServers?: NewSessionRequest["mcpServers"];
      additionalDirectories?: NewSessionRequest["additionalDirectories"];
      _meta?: NewSessionRequest["_meta"];
    },
    opts: { replayOnly?: boolean } = {},
  ): Promise<NewSessionResponse> {
    const existingSession = this.sessions[params.sessionId];
    if (existingSession) {
      const fingerprint = computeSessionFingerprint(params);
      if (opts.replayOnly || fingerprint === existingSession.sessionFingerprint) {
        return {
          sessionId: params.sessionId,
          modes: existingSession.modes,
          configOptions: existingSession.configOptions,
        };
      }

      await this.teardownSession(params.sessionId);
    }

    const response = await this.createSession(
      {
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
        additionalDirectories: params.additionalDirectories,
        _meta: params._meta,
      },
      {
        resume: params.sessionId,
        replayOnly: opts.replayOnly,
      },
    );

    return {
      sessionId: response.sessionId,
      modes: response.modes,
      configOptions: response.configOptions,
    };
  }

  private async createSession(
    params: NewSessionRequest,
    creationOpts: { resume?: string; forkSession?: boolean; replayOnly?: boolean } = {},
  ): Promise<NewSessionResponse> {
    let requestedSessionId: string;
    const isResume = !!creationOpts.resume && !creationOpts.forkSession;
    if (creationOpts.forkSession) {
      requestedSessionId = randomUUID();
    } else if (creationOpts.resume) {
      requestedSessionId = creationOpts.resume;
    } else {
      requestedSessionId = randomUUID();
    }

    const additionalDirs = resolveAdditionalDirs(params);
    const pluginDir = process.env.CC_MODS_PLUGIN_DIR;
    const onClient = workspaceOnClient({
      fs: this.clientCapabilities?.fs,
      environmentFile: Boolean(pluginDir && existsSync(path.join(pluginDir, ENVIRONMENT_FILE))),
    });
    const tuiCwd = resolveTuiCwd(params.cwd, onClient);
    if (onClient) trustTuiCwd(tuiCwd);
    if (pluginDir) {
      await writeSessionMount(pluginDir, params.cwd, additionalDirs);
    }
    const spawnDirs = onClient ? undefined : additionalDirs;

    const sessionMeta = params._meta as NewSessionMeta | null | undefined;
    const localToolForward = isLocalToolForwardEnabled(process.env, sessionMeta);
    const translatedMcp = translateMcpServers(params.mcpServers);
    let forwardMcpServers: ForwardingMcpServer[] | undefined;
    if (localToolForward) {
      assertForwardingStdioMcp(translatedMcp);
      const coverage = await resolveForwardingCoverage(translatedMcp, sessionMeta);
      forwardMcpServers = coverage.servers;
    }
    let mcpConfigFile: string | undefined;
    let appendSystemPromptFile: string | undefined;
    let disallowedTools: string[] | undefined;
    try {
      if (!creationOpts.replayOnly && params.mcpServers && params.mcpServers.length > 0) {
        mcpConfigFile = await writeMcpScratch(translatedMcp);
      }
      if (localToolForward && !creationOpts.replayOnly) {
        disallowedTools = resolveDisallowedBuiltins(sessionMeta);
        appendSystemPromptFile = await writeAppendSystemPromptFile(
          buildLocalEnvironmentAppend({
            cwd: params.cwd,
            servers: forwardMcpServers,
          }),
        );
      }
    } catch (err) {
      if (mcpConfigFile) await removeMcpScratch(mcpConfigFile);
      if (appendSystemPromptFile) await removeAppendSystemPromptFile(appendSystemPromptFile);
      throw err;
    }

    const settingsManager = new SettingsManager(params.cwd, {
      logger: this.logger,
    });
    await settingsManager.initialize();

    const allowBypass = sessionAllowsBypass(settingsManager.getSettings().permissions);
    const liveModelCatalog = await resolveModelCatalog(this.logger, this.modelCatalogSource);
    const agents = this.discoverAgents(params.cwd);
    const seed = parseSessionCreateMeta(params._meta, {
      allowBypass,
      catalog: liveModelCatalog,
      agents,
    });
    if (!isResume && !creationOpts.forkSession && seed.preferredSessionId) {
      requestedSessionId = seed.preferredSessionId;
    }
    disallowedTools = withDeniedAskUserQuestion(disallowedTools, seed.denyAskUserQuestion);
    const settingsMode = settingsManager.getSettings().permissions?.defaultMode;
    const seededMode =
      seed.permissionMode ??
      (settingsMode !== undefined
        ? resolvePermissionMode(settingsMode, this.logger, allowBypass)
        : allowBypass
          ? "bypassPermissions"
          : "default");
    const extraFlags = extraFlagsWithModel(this.relayFlags, seed.model);
    const seededModel = seed.model ?? DEFAULT_MODEL_INFO.value;

    const taskState: TaskState = new Map();

    const isFreshSpawn = !isResume && !creationOpts.forkSession && !creationOpts.replayOnly;
    let gate: SessionGate | undefined;
    if (this.gateEnabled && isFreshSpawn) {
      gate = await setupSessionGate({
        ...this.gateOptions,
        client: this.client,
        clientSupportsElicitationForm: this.clientSupportsElicitationForm,
        onWarn: (m) => this.logger.error(m),
      });
    }

    let started: StartedEngine;
    try {
      started = await this.startEngine({
        sessionId: requestedSessionId,
        cwd: tuiCwd,
        resume: isResume,
        fork: !!creationOpts.forkSession,
        resumeFrom: creationOpts.forkSession ? creationOpts.resume : undefined,
        replayOnly: creationOpts.replayOnly,
        sessions: this.engines,
        onEvent: (sid) => void this.pumpUpdates(sid),
        permissionMode: seededMode,
        settingsFile: gate?.settingsPath,
        additionalDirectories: spawnDirs,
        mcpConfigFile,
        disallowedTools,
        appendSystemPromptFile,
        extraFlags,
        agent: seed.agent,
      });
    } catch (error) {
      settingsManager.dispose();
      await gate?.teardown();
      if (mcpConfigFile) {
        await removeMcpScratch(mcpConfigFile);
      }
      if (appendSystemPromptFile) {
        await removeAppendSystemPromptFile(appendSystemPromptFile);
      }
      if (creationOpts.forkSession) {
        this.logger.error("[acp-agent] fork spawn failed:", error);
        throw error;
      }
      if (creationOpts.resume && error instanceof Error) {
        throw RequestError.resourceNotFound(creationOpts.resume);
      }
      throw error;
    }

    const startedSessionId = started.sessionId;
    if (started.engine) {
      this.engines.set(startedSessionId, started.engine);
    }

    if (gate) {
      const boundGate = gate;
      boundGate.bindSession(
        startedSessionId,
        () => void this.pumpUpdates(startedSessionId),
        (innerId) => {
          const s = this.sessions[startedSessionId];
          const entry = s?.sidechainParentMap?.get(innerId);
          if (!entry) return undefined;
          return {
            parentId: entry.parentId,
            subagentLabel: deriveSubagentLabel(s?.lastMessages ?? [], entry.parentId) ?? "subagent",
          };
        },
        () => this.sessions[startedSessionId]?.turnDetector?.noteActivity(),
      );
      boundGate.bindPty(started.pty as unknown as GatePty);
      started.pty.onExit(() => void boundGate.teardown());
    }

    const availableModes = buildAvailableModes(DEFAULT_MODEL_INFO, allowBypass);
    let currentModeId = seededMode;
    if (creationOpts.replayOnly && started.transcriptPath) {
      const recorded = await readTranscriptPermissionMode(started.transcriptPath);
      if (recorded !== undefined && availableModes.some((m) => m.id === recorded)) {
        currentModeId = recorded as PermissionMode;
      }
    }
    const modes: SessionModeState = {
      currentModeId,
      availableModes,
    };
    const configOptions = buildConfigOptions(
      modes,
      seededModel,
      liveModelCatalog,
      settingsManager.getSettings().effortLevel,
      agents,
      seed.agent,
      false,
      false,
      clientSupportsBooleanConfigOptions(this.clientCapabilities),
    );

    const runtimeCwd = started.cwd ?? tuiCwd;

    this.sessions[startedSessionId] = {
      pty: started.pty,
      watcher: started.watcher,
      emitted: new Set<string>(),
      emittedNested: new Set<string>(),
      toolUseCache: {},
      guardChecked: false,
      usageDisabled: false,
      engine: started.engine,
      cancelled: false,
      cwd: runtimeCwd,
      clientCwd: params.cwd,
      additionalDirectories: additionalDirs,
      mcpConfigFile,
      mcpServers: params.mcpServers,
      localToolForward,
      localToolForwardMeta: sessionMeta,
      forwardMcpServers,
      appendSystemPromptFile,
      disallowedTools,
      sessionFingerprint: computeSessionFingerprint(params),
      settingsManager,
      accumulatedUsage: { ...EMPTY_USAGE },
      lastContextUsed: 0,
      startedAtMs: Date.now(),
      modes,
      modelInfos: liveModelCatalog,
      allowBypass,
      agents,
      configOptions,
      contextWindowSize:
        inferContextWindowFromModel(seededModel) ?? DEFAULT_CONTEXT_WINDOW,
      taskState,
      gate,
      origin: sessionOrigin(creationOpts),
      hadUserPrompt: false,
    };

    void this.refreshFastMode(startedSessionId, this.sessions[startedSessionId]);

    return {
      sessionId: startedSessionId,
      modes,
      configOptions,
    };
  }
}

function buildAvailableModes(
  modelInfo: ModelInfo | undefined,
  allowBypass: boolean,
): SessionModeState["availableModes"] {
  const modes: SessionModeState["availableModes"] = [];

  if (modelInfo?.supportsAutoMode === true) {
    modes.push({
      id: "auto",
      name: "Auto",
      description: "Use a model classifier to approve/deny permission prompts",
      _meta: { kind: "auto_review" },
    });
  }

  modes.push(
    {
      id: "default",
      name: "Default",
      description: "Standard behavior, prompts for dangerous operations",
      _meta: { kind: "standard" },
    },
    {
      id: "acceptEdits",
      name: "Accept Edits",
      description: "Auto-accept file edit operations",
      _meta: { kind: "standard" },
    },
    {
      id: "plan",
      name: "Plan Mode",
      description: "Planning mode, no actual tool execution",
      _meta: { kind: "plan" },
    },
    {
      id: "dontAsk",
      name: "Don't Ask",
      description:
        "Don't prompt for permissions, deny if not pre-approved. Selecting this restarts the session.",
    },
  );

  if (allowBypass) {
    modes.push({
      id: "bypassPermissions",
      name: "Bypass Permissions",
      description: "Bypass all permission checks. Selecting this restarts the session.",
      _meta: { kind: "full_access" },
    });
  }

  return modes;
}

function buildConfigOptions(
  modes: SessionModeState,
  currentModelId: string,
  modelInfos: ModelInfo[],
  currentEffortLevel?: string,
  agents: AgentCatalogEntry[] = [],
  currentAgent?: string,
  fastAvailable = false,
  currentFast = false,
  fastUsesBooleanOption = false,
  ultracode: { on: boolean; refusal?: string } = { on: false },
): SessionConfigOption[] {
  const options: SessionConfigOption[] = [
    {
      id: "mode",
      name: "Mode",
      description: "Session permission mode",
      category: "mode",
      type: "select",
      currentValue: modes.currentModeId,
      options: modes.availableModes.map((m) => ({
        value: m.id,
        name: m.name,
        description: m.description,
        _meta: m._meta,
      })),
    },
    {
      id: "model",
      name: "Model",
      description: "AI model to use",
      category: "model",
      type: "select",
      currentValue: currentModelId,
      options: modelInfos.map((m) => ({
        value: m.value,
        name: m.displayName,
        description: modelSelectorDescription(m) || undefined,
      })),
    },
  ];

  if (isFastModeCapableModel(currentModelId) && fastAvailable) {
    options.push(createFastModeConfigOption(currentFast, fastUsesBooleanOption));
  }

  const currentModelInfo = modelInfos.find((m) => m.value === currentModelId);
  const supportedLevels = (
    currentModelInfo?.supportsEffort
      ? (currentModelInfo.supportedEffortLevels ?? REASONING_EFFORT_LEVELS)
      : REASONING_EFFORT_LEVELS
  ) as string[];

  const effortOptions = [
    { value: "default", name: "Default" },
    ...supportedLevels.map((level) => ({
      value: level,
      name: level
        .split(/[_-]/)
        .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
        .join(" "),
    })),
  ];

  const includes = (l: string) => l === "default" || supportedLevels.includes(l);
  const validEffort =
    currentEffortLevel && includes(currentEffortLevel) ? currentEffortLevel : "default";

  options.push({
    id: "effort",
    name: "Effort",
    description: "Thinking intensity: how much reasoning the model applies",
    category: "thought_level",
    type: "select",
    currentValue: validEffort,
    options: effortOptions,
  });

  if (isUltracodeCapableModel(currentModelInfo)) {
    options.push(
      createUltracodeConfigOption(ultracode.on, fastUsesBooleanOption, ultracode.refusal),
    );
  }

  if (agents.length > 0) {
    const agentValues = new Set(agents.map((a) => a.value));
    const validAgent = currentAgent && agentValues.has(currentAgent) ? currentAgent : "default";
    options.push({
      id: "agent",
      name: "Agent",
      description: "Main-thread agent persona",
      category: "model",
      type: "select",
      currentValue: validAgent,
      options: [
        { value: "default", name: "Default" },
        ...agents.map((a) => ({ value: a.value, name: a.displayName, description: a.description })),
      ],
    });
  }

  return options;
}

const MODEL_CONTEXT_HINT_PATTERN = /\[(\d+m)\]$/i;

const MODEL_FAMILY_VERSION_PATTERN = /\b(\d+)[-.](\d+)\b/;

function extractModelFamilyVersion(s: string): string | null {
  const match = s.match(MODEL_FAMILY_VERSION_PATTERN);
  return match ? `${match[1]}.${match[2]}` : null;
}

function modelVersionsCompatible(preference: string, candidate: ModelInfo): boolean {
  const preferred = extractModelFamilyVersion(preference);
  if (!preferred) return true;
  const candidateVersion =
    extractModelFamilyVersion(candidate.value) ??
    extractModelFamilyVersion(candidate.displayName) ??
    extractModelFamilyVersion(candidate.description);
  if (!candidateVersion) return true;
  return preferred === candidateVersion;
}

function tokenizeModelPreference(model: string): { tokens: string[]; contextHint?: string } {
  const lower = model.trim().toLowerCase();
  const contextHint = lower.match(MODEL_CONTEXT_HINT_PATTERN)?.[1]?.toLowerCase();

  const normalized = lower.replace(MODEL_CONTEXT_HINT_PATTERN, " $1 ");
  const rawTokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const tokens = rawTokens
    .map((token) => {
      if (token === "opusplan") return "opus";
      if (token === "best" || token === "default") return "";
      return token;
    })
    .filter((token) => token && token !== "claude")
    .filter((token) => /[a-z]/.test(token) || token.endsWith("m"));

  return { tokens, contextHint };
}

function scoreModelMatch(model: ModelInfo, tokens: string[], contextHint?: string): number {
  const haystack = `${model.value} ${model.displayName}`.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += token === contextHint ? 3 : 1;
    }
  }
  return score;
}

function resolveModelPreference(models: ModelInfo[], preference: string): ModelInfo | null {
  const trimmed = preference.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();

  const directMatch = models.find(
    (model) =>
      model.value === trimmed ||
      model.value.toLowerCase() === lower ||
      model.displayName.toLowerCase() === lower,
  );
  if (directMatch) return directMatch;

  const includesMatch = models.find((model) => {
    if (!modelVersionsCompatible(trimmed, model)) return false;
    const value = model.value.toLowerCase();
    const display = model.displayName.toLowerCase();
    return value.includes(lower) || display.includes(lower) || lower.includes(value);
  });
  if (includesMatch) return includesMatch;

  const { tokens, contextHint } = tokenizeModelPreference(trimmed);
  if (tokens.length === 0) return null;

  let bestMatch: ModelInfo | null = null;
  let bestScore = 0;
  for (const model of models) {
    if (!modelVersionsCompatible(trimmed, model)) continue;
    const score = scoreModelMatch(model, tokens, contextHint);
    if (0 < score && (!bestMatch || bestScore < score)) {
      bestMatch = model;
      bestScore = score;
    }
  }

  return bestMatch;
}

export const EMBEDDED_RESOURCE_INLINE_THRESHOLD = 2048;

function filePathFromUri(uri: string): string | null {
  return uri.startsWith("file://") ? uri.slice("file://".length) : null;
}

export function promptToClaude(
  prompt: PromptRequest,
  logger: Logger = console,
  materializedSink?: string[],
): string {
  const fragments: string[] = [];
  let materializedAnyImage = false;

  for (const chunk of prompt.prompt) {
    try {
      switch (chunk.type) {
        case "text": {
          let text = chunk.text;
          const mcpMatch = text.match(/^\/mcp:([^:\s]+):(\S+)(?:\s(.*))?$/);
          if (mcpMatch) {
            const [, server, command, args] = mcpMatch;
            text = `/${server}:${command} (MCP)${args ? ` ${args}` : ""}`;
          }
          fragments.push(text);
          break;
        }
        case "resource_link": {
          const path = filePathFromUri(chunk.uri);
          if (path !== null) {
            fragments.push(`@${path}`);
          } else {
            const label = chunk.name ?? chunk.uri;
            fragments.push(`[${label}](${chunk.uri})`);
          }
          break;
        }
        case "resource": {
          if (chunk.resource && "text" in chunk.resource) {
            const content = chunk.resource.text;
            const path = filePathFromUri(chunk.resource.uri);
            if (content.length >= EMBEDDED_RESOURCE_INLINE_THRESHOLD && path !== null) {
              fragments.push(`@${path}`);
            } else {
              fragments.push(content);
            }
          }
          break;
        }
        case "image": {
          const tempPath = materializeImage(chunk.data, chunk.mimeType);
          materializedSink?.push(tempPath);
          fragments.push(`@${tempPath}`);
          materializedAnyImage = true;
          break;
        }
        case "audio":
          break;
        default:
          logger.error(
            "promptToClaude: skipped an unknown content block",
            (chunk as { type?: unknown }).type,
          );
          break;
      }
    } catch (err) {
      logger.error("promptToClaude: skipped a malformed content block", err);
      continue;
    }
  }

  if (materializedAnyImage) {
    fragments.push("Read the attached image(s) above and use them to answer.");
  }

  return fragments.filter((fragment) => fragment.length > 0).join(" ");
}

export function toAcpNotifications(
  content: string | ContentBlockParam[] | BetaContentBlock[] | BetaRawContentBlockDelta[],
  role: "assistant" | "user",
  sessionId: string,
  toolUseCache: ToolUseCache,
  client: AcpClient,
  logger: Logger,
  options?: {
    registerHooks?: boolean;
    clientCapabilities?: ClientCapabilities;
    parentToolUseId?: string | null;
    cwd?: string;
    taskState?: TaskState;
    toolUseResult?: unknown;
    background?: {
      ended: (toolUseId: string) => BackgroundTaskEnd | undefined;
      held?: Set<string>;
    };
  },
): SessionNotification[] {
  const taskState = options?.taskState ?? new Map();
  const registerHooks = options?.registerHooks !== false;
  const supportsTerminalOutput = options?.clientCapabilities?._meta?.["terminal_output"] === true;
  if (typeof content === "string") {
    if (content.length === 0) return [];
    const update: SessionNotification["update"] = {
      sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
      content: {
        type: "text",
        text: content,
      },
    };

    if (options?.parentToolUseId) {
      update._meta = {
        ...update._meta,
        claudeCode: {
          ...(update._meta?.claudeCode || {}),
          parentToolUseId: options.parentToolUseId,
        },
      };
    }

    return [{ sessionId, update }];
  }

  if (!Array.isArray(content)) return [];

  const toolUseResult =
    options?.toolUseResult !== undefined &&
    content.filter((c) => typeof c === "object" && c !== null && c.type === "tool_result")
      .length === 1
      ? options.toolUseResult
      : undefined;

  const output = [];
  for (const chunk of content) {
    let update: SessionNotification["update"] | null = null;
    switch (chunk.type) {
      case "text":
      case "text_delta":
        update = {
          sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
          content: {
            type: "text",
            text: chunk.text,
          },
        };
        break;
      case "image":
        update = {
          sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
          content: {
            type: "image",
            data: chunk.source.type === "base64" ? chunk.source.data : "",
            mimeType: chunk.source.type === "base64" ? chunk.source.media_type : "",
            uri: chunk.source.type === "url" ? chunk.source.url : undefined,
          },
        };
        break;
      case "thinking":
      case "thinking_delta":
        if (chunk.thinking.length > 0) {
          update = {
            sessionUpdate: "agent_thought_chunk",
            content: {
              type: "text",
              text: chunk.thinking,
            },
          };
        }
        break;
      case "tool_use":
      case "server_tool_use":
      case "mcp_tool_use": {
        const alreadyCached = chunk.id in toolUseCache;
        toolUseCache[chunk.id] = chunk;
        if (chunk.name === "TodoWrite") {
          // @ts-expect-error - sometimes input is empty object or undefined
          if (Array.isArray(chunk.input?.todos)) {
            update = {
              sessionUpdate: "plan",
              entries: planEntries(chunk.input as { todos: ClaudePlanEntry[] }),
            };
          }
        } else if (
          chunk.name === "TaskCreate" ||
          chunk.name === "TaskUpdate" ||
          chunk.name === "TaskList" ||
          chunk.name === "TaskGet"
        ) {
        } else {
          if (registerHooks && !alreadyCached) {
            registerHookCallback(chunk.id, {
              onPostToolUseHook: async (toolUseId, toolInput, toolResponse) => {
                const toolUse = toolUseCache[toolUseId];
                if (toolUse) {
                  const editDiff =
                    toolUse.name === "Edit" || toolUse.name === "Write"
                      ? toolUpdateFromDiffToolResponse(toolResponse)
                      : {};
                  const update: SessionNotification["update"] = {
                    _meta: {
                      claudeCode: {
                        ...claudeCodeMetaFromToolUse(toolUse, options?.cwd),
                        toolResponse,
                      },
                    } satisfies ToolUpdateMeta,
                    toolCallId: toolUseId,
                    sessionUpdate: "tool_call_update",
                    ...editDiff,
                  };
                  await client.sessionUpdate({
                    sessionId,
                    update,
                  });
                } else {
                  logger.error(
                    `[claude-agent-acp] Got a tool response for tool use that wasn't tracked: ${toolUseId}`,
                  );
                }
              },
            });
          }

          let rawInput;
          try {
            rawInput = JSON.parse(JSON.stringify(chunk.input));
          } catch {
          }

          if (alreadyCached) {
            update = {
              _meta: {
                claudeCode: claudeCodeMetaFromToolUse(chunk, options?.cwd),
              } satisfies ToolUpdateMeta,
              toolCallId: chunk.id,
              sessionUpdate: "tool_call_update",
              rawInput,
              ...toolInfoFromToolUse(chunk, supportsTerminalOutput, options?.cwd),
            };
          } else {
            update = {
              _meta: {
                claudeCode: claudeCodeMetaFromToolUse(chunk, options?.cwd),
                ...(chunk.name === "Bash" && supportsTerminalOutput
                  ? { terminal_info: { terminal_id: chunk.id } }
                  : {}),
              } satisfies ToolUpdateMeta,
              toolCallId: chunk.id,
              sessionUpdate: "tool_call",
              rawInput,
              status: "pending",
              ...toolInfoFromToolUse(chunk, supportsTerminalOutput, options?.cwd),
            };
          }
        }
        break;
      }

      case "tool_result":
      case "tool_search_tool_result":
      case "web_fetch_tool_result":
      case "web_search_tool_result":
      case "code_execution_tool_result":
      case "bash_code_execution_tool_result":
      case "text_editor_code_execution_tool_result":
      case "mcp_tool_result": {
        const toolUse = toolUseCache[chunk.tool_use_id];
        if (!toolUse) {
          logger.error(
            `[claude-agent-acp] Got a tool result for tool use that wasn't tracked: ${chunk.tool_use_id}`,
          );
          break;
        }

        if (
          toolUse.name === "TaskCreate" ||
          toolUse.name === "TaskUpdate" ||
          toolUse.name === "TaskList" ||
          toolUse.name === "TaskGet"
        ) {
          const isError = "is_error" in chunk && chunk.is_error;
          let shouldEmitTaskPlan = false;
          if (!isError) {
            if (toolUse.name === "TaskCreate") {
              applyTaskCreate(
                taskState,
                toolUse.input as Parameters<typeof applyTaskCreate>[1],
                parseTaskCreateOutput(toolUseResult) ?? parseTaskCreateOutput(chunk.content),
              );
              shouldEmitTaskPlan = true;
            } else if (toolUse.name === "TaskUpdate") {
              const input = toolUse.input as Parameters<typeof applyTaskUpdate>[1];
              const output =
                parseTaskUpdateOutput(toolUseResult, input?.taskId) ??
                parseTaskUpdateOutput(chunk.content, input?.taskId);
              if (!output || (output.success && output.taskId === input?.taskId)) {
                applyTaskUpdate(taskState, input);
                shouldEmitTaskPlan = true;
              }
            } else if (toolUse.name === "TaskList") {
              const output =
                parseTaskListOutput(toolUseResult) ?? parseTaskListOutput(chunk.content);
              if (output) {
                applyTaskList(taskState, output);
                shouldEmitTaskPlan = true;
              }
            }
          }
          if (shouldEmitTaskPlan) {
            update = {
              sessionUpdate: "plan",
              entries: taskStateToPlanEntries(taskState),
            };
          }
        } else if (toolUse.name !== "TodoWrite") {
          const background = options?.background;
          const { _meta: toolMeta, ...toolUpdate } = toolUpdateFromToolResult(
            chunk,
            toolUseCache[chunk.tool_use_id],
            supportsTerminalOutput,
            toolUseResult,
            background
              ? { ended: background.ended, holdRunning: background.held !== undefined }
              : undefined,
          );
          if (background?.held && toolMeta?.terminal_info && !toolMeta.terminal_exit) {
            background.held.add(toolMeta.terminal_info.terminal_id);
          }

          if (toolMeta?.terminal_output) {
            output.push({
              sessionId,
              update: {
                _meta: {
                  terminal_output: toolMeta.terminal_output,
                  ...(options?.parentToolUseId
                    ? { claudeCode: { parentToolUseId: options.parentToolUseId } }
                    : {}),
                },
                toolCallId: chunk.tool_use_id,
                sessionUpdate: "tool_call_update" as const,
              },
            });
          }

          update = {
            _meta: {
              claudeCode: claudeCodeMetaFromToolUse(toolUse, options?.cwd),
              ...(toolMeta?.terminal_exit ? { terminal_exit: toolMeta.terminal_exit } : {}),
            } satisfies ToolUpdateMeta,
            toolCallId: chunk.tool_use_id,
            sessionUpdate: "tool_call_update",
            status: "is_error" in chunk && chunk.is_error ? "failed" : "completed",
            rawOutput: chunk.content,
            ...toolUpdate,
          };
        }
        break;
      }

      case "document":
      case "search_result":
      case "redacted_thinking":
      case "input_json_delta":
      case "citations_delta":
      case "signature_delta":
      case "container_upload":
      case "compaction":
      case "compaction_delta":
      case "advisor_tool_result":
      case "fallback":
      case "mcp_tool_listing":
        break;

      default:
        unreachable(chunk, logger);
        break;
    }
    if (update) {
      if (options?.parentToolUseId) {
        update._meta = {
          ...update._meta,
          claudeCode: {
            ...(update._meta?.claudeCode || {}),
            parentToolUseId: options.parentToolUseId,
          },
        };
      }
      output.push({ sessionId, update });
    }
  }

  return output;
}

export function runAcp(deps?: AgentDeps) {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);

  const stream = ndJsonStream(input, output);
  // eslint-disable-next-line prefer-const
  let agent: ClaudeAcpAgent;
  const connection = acpAgent()
    .onRequest(methods.agent.initialize, (ctx) => agent.initialize(ctx.params))
    .onRequest(methods.agent.session.new, (ctx) => agent.newSession(ctx.params))
    .onRequest(
      methods.agent.authenticate,
      async (ctx) => (await agent.authenticate(ctx.params)) ?? {},
    )
    .onRequest(methods.agent.session.prompt, (ctx) => {
      const abort = () => {
        void agent.cancel({ sessionId: ctx.params.sessionId });
      };
      if (ctx.signal.aborted) abort();
      else ctx.signal.addEventListener("abort", abort, { once: true });
      return agent.prompt(ctx.params).finally(() => {
        ctx.signal.removeEventListener("abort", abort);
      });
    })
    .onNotification(methods.agent.session.cancel, (ctx) => agent.cancel(ctx.params))
    .onRequest(methods.agent.session.load, (ctx) => agent.loadSession(ctx.params))
    .onRequest(methods.agent.session.list, (ctx) => agent.listSessions(ctx.params))
    .onRequest(
      methods.agent.session.delete,
      async (ctx) => (await agent.deleteSession(ctx.params)) ?? {},
    )
    .onRequest(methods.agent.session.fork, (ctx) => agent.unstable_forkSession(ctx.params))
    .onRequest(methods.agent.session.resume, (ctx) => agent.resumeSession(ctx.params))
    .onRequest(
      methods.agent.session.close,
      async (ctx) => (await agent.closeSession(ctx.params)) ?? {},
    )
    .onRequest(
      methods.agent.session.setMode,
      async (ctx) => (await agent.setSessionMode(ctx.params)) ?? {},
    )
    .onRequest(methods.agent.session.setConfigOption, (ctx) =>
      agent.setSessionConfigOption(ctx.params),
    )
    .onRequest(methods.agent.session.setTitle, (ctx) => agent.setSessionTitle(ctx.params))
    .onRequest("_x.ai/session/rename", parseGrokSessionRename, (ctx) =>
      agent.handleGrokSessionRename(ctx.params),
    )
    .onRequest("x.ai/session/rename", parseGrokSessionRename, (ctx) =>
      agent.handleGrokSessionRename(ctx.params),
    )
    .onRequest("_x.ai/session/info", parseGrokSessionId, (ctx) =>
      agent.handleGrokSessionInfo(ctx.params),
    )
    .onRequest("x.ai/session/info", parseGrokSessionId, (ctx) =>
      agent.handleGrokSessionInfo(ctx.params),
    )
    .onRequest("_x.ai/session/usage", parseGrokSessionId, (ctx) =>
      agent.handleGrokSessionUsage(ctx.params),
    )
    .onRequest("x.ai/session/usage", parseGrokSessionId, (ctx) =>
      agent.handleGrokSessionUsage(ctx.params),
    )
    .onRequest("_x.ai/interject", parseGrokInterject, (ctx) =>
      agent.handleGrokInterject(ctx.params),
    )
    .onRequest("x.ai/interject", parseGrokInterject, (ctx) =>
      agent.handleGrokInterject(ctx.params),
    )
    .onRequest(methods.agent.logout, async (ctx) => (await agent.logout(ctx.params)) ?? {})
    .connect(stream);
  agent = new ClaudeAcpAgent(new ClientConnection(connection.client), undefined, deps);
  return { connection, agent };
}

export function inferContextWindowFromModel(model: string): number | null {
  const mapped = MODEL_CONTEXT_WINDOWS[model];
  if (mapped !== undefined) return mapped;
  if (/\b1m\b/i.test(model)) return 1_000_000;
  return inferContextWindowFromModelId(model);
}

export function inferContextWindowFromModelId(id: string): number | null {
  if (typeof id !== "string" || id.length === 0) return null;
  const exact = MODEL_ID_CONTEXT_WINDOWS[id];
  if (exact !== undefined) return exact;
  if (/\b1m\b/i.test(id)) return 1_000_000;
  const opus = id.match(/claude-opus-(\d+)-(\d+)/);
  if (opus) {
    const major = Number(opus[1]);
    const minor = Number(opus[2]);
    return major > 4 || (major === 4 && minor >= 7) ? 1_000_000 : 200_000;
  }
  if (/claude-fable/.test(id)) return 1_000_000;
  const sonnet = id.match(/claude-sonnet-(\d+)/);
  if (sonnet) return Number(sonnet[1]) >= 5 ? 1_000_000 : 200_000;
  const haiku = id.match(/claude-haiku-(\d+)/);
  if (haiku) return Number(haiku[1]) >= 5 ? 1_000_000 : 200_000;
  return null;
}

function mcpServerNames(servers: NewSessionRequest["mcpServers"] | undefined): string[] {
  if (!servers) return [];
  return servers.map((server) => {
    if (server && typeof server === "object" && "name" in server && typeof server.name === "string") {
      return server.name;
    }
    return "mcp";
  });
}

function latestContextUsage(messages: SessionMessage[] | undefined): Record<string, unknown> | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const value = messages[i]?.contextUsage;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

function latestContextUsageFromTranscript(sessionId: string): ContextUsageSnapshot | undefined {
  const matches = findTranscript(sessionId);
  if (matches.length !== 1) return undefined;
  return scanContextUsageFromJsonl(readFileTail(matches[0]));
}

function grokSessionInfo(
  sessionId: string,
  session: Session,
  model: string,
  modelDisplayName: string,
): Record<string, unknown> {
  const snapshot =
    session.lastContextSnapshot ??
    (latestContextUsage(session.lastMessages) as ContextUsageSnapshot | undefined);
  const context = grokContextFromSnapshot(snapshot, {
    used: session.lastContextUsed,
    total: session.contextWindowSize,
    mcpServers: mcpServerNames(session.mcpServers),
  });
  return {
    sessionId,
    cwd: session.clientCwd || session.cwd,
    agentName: "claude",
    model,
    modelDisplayName,
    resolvedModelId: model,
    turns: context.turnCount,
    turnIndex: context.turnCount,
    context,
  };
}

function abortedPermission(signal: AbortSignal): Promise<RequestPermissionResponse> {
  return new Promise((resolve) => {
    const settle = () => resolve({ outcome: { outcome: "cancelled" } });
    if (signal.aborted) {
      settle();
      return;
    }
    signal.addEventListener("abort", settle, { once: true });
  });
}

function consumePendingInterject(session: Session, content: unknown): boolean {
  const pending = session.pendingInterjectTexts;
  if (!pending?.length) return false;
  const text = flattenUserText(content);
  if (!text) return false;
  const index = pending.findIndex(
    (item) => item === text || text === item || text.startsWith(item) || item.startsWith(text),
  );
  if (index < 0) return false;
  pending.splice(index, 1);
  return true;
}

function flattenUserText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as { type?: unknown; text?: unknown };
    if (rec.type === "text" && typeof rec.text === "string") parts.push(rec.text);
  }
  return parts.join("").trim();
}

function grokPromptUsage(session: Session): Record<string, unknown> {
  const inputTokens = Math.max(0, Math.round(session.accumulatedUsage.inputTokens));
  const outputTokens = Math.max(0, Math.round(session.accumulatedUsage.outputTokens));
  const cachedReadTokens = Math.max(0, Math.round(session.accumulatedUsage.cachedReadTokens));
  const cacheCreationTokens = Math.max(0, Math.round(session.accumulatedUsage.cachedWriteTokens));
  const usage: Record<string, unknown> = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cachedReadTokens,
    cacheCreationTokens,
    modelCalls: 0,
    numTurns: 0,
  };
  if (typeof session.lastCostUsd === "number" && Number.isFinite(session.lastCostUsd)) {
    usage.costUsdTicks = Math.round(session.lastCostUsd * USD_TICKS_PER_USD);
  }
  return usage;
}
