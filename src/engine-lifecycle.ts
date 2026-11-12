import { createHerdrSpawn } from "./herdr-backend.js";
import {
  assertSpawnEnvUntainted,
  buildAddDirFlags,
  buildSanitizedEnv,
  extraClaudeFlags,
  resolveShell,
  spawnClaudePty,
  type CcModsRelayFlags,
} from "./engine-pty.js";
import { appendSystemPromptFileFlag, disallowedToolsFlag } from "./local-tool-forward.js";
import type { PtyEngineHandle } from "./engine-pty.js";
import { isSafeAgentRef } from "./agent-catalog.js";
import { isSessionId } from "./session-delete.js";

export interface SessionWatcher {
  stop(): void;
}

export interface CleanupInfo {
  sessionId: string;
  exitCode?: number;
  signal?: number;
}

export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 40;

export const RESIZE_DEBOUNCE_MS = 100;

export interface SessionEngineOptions {
  handle: PtyEngineHandle;
  watcher?: SessionWatcher;
  sessions?: Map<string, SessionEngine>;
  onCleanup?: (info: CleanupInfo) => void;
  resizeDebounceMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export class SessionEngine {
  readonly sessionId: string;
  readonly pty: PtyEngineHandle["pty"];
  watcher?: SessionWatcher;

  private readonly sessions?: Map<string, SessionEngine>;
  private readonly onCleanup?: (info: CleanupInfo) => void;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly debounceMs: number;
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private pendingSize?: { cols: number; rows: number };
  private disposed = false;
  private pendingDiscovery?: AbortController;

  constructor(opts: SessionEngineOptions) {
    this.sessionId = opts.handle.sessionId;
    this.pty = opts.handle.pty;
    this.watcher = opts.watcher;
    this.sessions = opts.sessions;
    this.onCleanup = opts.onCleanup;
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
    this.debounceMs = opts.resizeDebounceMs ?? RESIZE_DEBOUNCE_MS;

    this.sessions?.set(this.sessionId, this);

    this.pty.onExit(({ exitCode, signal }) => this.cleanup({ exitCode, signal }));
  }

  requestResize(cols: number = DEFAULT_COLS, rows: number = DEFAULT_ROWS): void {
    if (this.disposed) return;
    this.pendingSize = { cols, rows };
    if (this.resizeTimer !== undefined) this.clearTimeoutFn(this.resizeTimer);
    this.resizeTimer = this.setTimeoutFn(() => {
      this.resizeTimer = undefined;
      if (this.disposed || !this.pendingSize) return;
      const { cols: c, rows: r } = this.pendingSize;
      this.pendingSize = undefined;
      this.pty.resize(c, r);
    }, this.debounceMs);
  }

  interrupt(): void {
    if (this.disposed) return;
    this.pty.write("\x03");
  }

  escape(): void {
    if (this.disposed) return;
    this.pty.write("\x1b");
  }

  /** Always reap the TUI, even if cleanup already ran (onExit). */
  kill(signal?: string): void {
    try {
      this.pty.kill(signal);
    } catch {
    }
    this.cleanup();
  }

  cleanup(info?: { exitCode?: number; signal?: number }): void {
    if (this.disposed) return;
    this.disposed = true;

    this.pendingDiscovery?.abort();
    this.pendingDiscovery = undefined;

    if (this.resizeTimer !== undefined) {
      this.clearTimeoutFn(this.resizeTimer);
      this.resizeTimer = undefined;
    }
    this.pendingSize = undefined;

    if (this.watcher) {
      this.watcher.stop();
      this.watcher = undefined;
    }
    this.sessions?.delete(this.sessionId);

    this.onCleanup?.({ sessionId: this.sessionId, exitCode: info?.exitCode, signal: info?.signal });
  }

  setPendingDiscovery(ac: AbortController): void {
    this.pendingDiscovery = ac;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}

const RESUME_PTY_NAME = "xterm-256color";

export type ResumeLaunchOpts = {
  /** When set, `claude --resume SOURCE --fork-session --session-id NEW`. */
  forkSessionId?: string;
};

export function buildResumeArgv(
  sessionId: string,
  permissionMode?: string,
  effortLevel?: string,
  agent?: string,
  additionalDirectories?: string[],
  mcpConfigFile?: string,
  disallowedTools?: string[],
  appendSystemPromptFile?: string,
  extraFlags?: CcModsRelayFlags,
  launch?: ResumeLaunchOpts,
): [string, string] {
  const pm =
    permissionMode && permissionMode !== "default" ? ` --permission-mode ${permissionMode}` : "";
  const ef = effortLevel && effortLevel !== "default" ? ` --effort ${effortLevel}` : "";
  const ag = agent && agent !== "default" && isSafeAgentRef(agent) ? ` --agent "${agent}"` : "";
  const dirs = buildAddDirFlags(additionalDirectories);
  const mcp = mcpConfigFile ? ` --mcp-config "${mcpConfigFile}"` : "";
  const denied = disallowedToolsFlag(disallowedTools);
  const append = appendSystemPromptFileFlag(appendSystemPromptFile);
  const flags = `${pm}${ef}${ag}${dirs}${mcp}${denied}${append}${extraClaudeFlags(extraFlags)}`;
  if (!isSessionId(sessionId)) {
    throw new Error(`engine-lifecycle: resume session id is not a UUID: ${JSON.stringify(sessionId)}`);
  }
  const forkId = launch?.forkSessionId;
  if (forkId) {
    if (!isSessionId(forkId)) {
      throw new Error(`engine-lifecycle: fork session id is not a UUID: ${JSON.stringify(forkId)}`);
    }
    return ["-c", `exec claude --resume "${sessionId}" --fork-session --session-id "${forkId}"${flags}`];
  }
  return ["-c", `exec claude --resume "${sessionId}"${flags}`];
}

export interface SpawnResumeOptions {
  sessionId: string;
  cwd: string;
  baseEnv?: Record<string, string | undefined>;
  spawn?: import("./terminal-backend.js").TerminalSpawn;
  permissionMode?: string;
  effortLevel?: string;
  agent?: string;
  additionalDirectories?: string[];
  mcpConfigFile?: string;
  disallowedTools?: string[];
  appendSystemPromptFile?: string;
  extraFlags?: CcModsRelayFlags;
  /** ACP session id for a `--fork-session` spawn (distinct from the source `sessionId`). */
  forkedSessionId?: string;
}

export function spawnResumePty(opts: SpawnResumeOptions): PtyEngineHandle {
  const { sessionId, cwd, baseEnv = process.env, spawn = createHerdrSpawn({ herdrSession: process.env.CLAUDE_TUI_HERDR_SESSION || "default" }) } = opts;

  const shell = resolveShell(baseEnv);
  const argv = buildResumeArgv(
    sessionId,
    opts.permissionMode,
    opts.effortLevel,
    opts.agent,
    opts.additionalDirectories,
    opts.mcpConfigFile,
    opts.disallowedTools,
    opts.appendSystemPromptFile,
    opts.extraFlags,
    opts.forkedSessionId ? { forkSessionId: opts.forkedSessionId } : undefined,
  );
  const env = buildSanitizedEnv(baseEnv);

  assertSpawnEnvUntainted(env);

  const p = spawn(shell, argv, {
    name: RESUME_PTY_NAME,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    cwd,
    env: env as { [key: string]: string },
  });

  return { sessionId: opts.forkedSessionId ?? sessionId, pty: p };
}

export interface CreateSessionEngineOptions {
  cwd: string;
  sessionId?: string;
  baseEnv?: Record<string, string | undefined>;
  spawn?: import("./terminal-backend.js").TerminalSpawn;
  permissionMode?: string;
  effortLevel?: string;
  agent?: string;
  additionalDirectories?: string[];
  mcpConfigFile?: string;
  disallowedTools?: string[];
  appendSystemPromptFile?: string;
  extraFlags?: CcModsRelayFlags;
  settingsFile?: string;
  startWatcher?: (sessionId: string, p: PtyEngineHandle["pty"]) => SessionWatcher;
  sessions?: Map<string, SessionEngine>;
  resizeDebounceMs?: number;
  onCleanup?: (info: CleanupInfo) => void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export function createSessionEngine(opts: CreateSessionEngineOptions): SessionEngine {
  const handle = spawnClaudePty({
    cwd: opts.cwd,
    baseEnv: opts.baseEnv,
    spawn: opts.spawn,
    sessionId: opts.sessionId,
    permissionMode: opts.permissionMode,
    effortLevel: opts.effortLevel,
    agent: opts.agent,
    settingsFile: opts.settingsFile,
    additionalDirectories: opts.additionalDirectories,
    mcpConfigFile: opts.mcpConfigFile,
    disallowedTools: opts.disallowedTools,
    appendSystemPromptFile: opts.appendSystemPromptFile,
    extraFlags: opts.extraFlags,
  });
  const watcher = opts.startWatcher?.(handle.sessionId, handle.pty);

  return new SessionEngine({
    handle,
    watcher,
    sessions: opts.sessions,
    resizeDebounceMs: opts.resizeDebounceMs,
    onCleanup: opts.onCleanup,
    setTimeoutFn: opts.setTimeoutFn,
    clearTimeoutFn: opts.clearTimeoutFn,
  });
}
