import { randomUUID } from "node:crypto";
import { createHerdrSpawn } from "./herdr-backend.js";
import type { EngineTerminal, TerminalSpawn } from "./terminal-backend.js";
import { appendSystemPromptFileFlag, disallowedToolsFlag } from "./local-tool-forward.js";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { isSafeAgentRef } from "./agent-catalog.js";
import { debug } from "./debug.js";

const PTY_NAME = "xterm-256color";
const PTY_COLS = 120;
const PTY_ROWS = 40;

export const FORBIDDEN_BILLING_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_AGENT_SDK_CLIENT_APP",
] as const;

export const TODO_TOOLS_ENV = "CLAUDE_CODE_ENABLE_TODO_TOOLS";

/** Agent/herdr internals — not a normal user session. Keep CC_MODS_SOCKET for Mods. */
const TUI_ENV_DENY_PREFIXES = ["FORK_", "CLAUDE_TUI_"] as const;
const TUI_ENV_DENY_KEYS = new Set<string>([
  ...FORBIDDEN_BILLING_VARS,
  "HERDR_ENV",
  "HERDR_SESSION",
]);

export type CcModsRelayFlags = {
  noChrome?: boolean;
  skipPermissions?: boolean;
  tools?: string[];
  model?: string;
};

const MODEL_NAME = /^[A-Za-z0-9._-]+$/;

export function parseCcModsRelayMeta(meta: unknown): CcModsRelayFlags {
  if (!meta || typeof meta !== "object") return {};
  const raw = (meta as { ccModsRelay?: unknown }).ccModsRelay;
  if (!raw || typeof raw !== "object") return {};
  const row = raw as { noChrome?: unknown; skipPermissions?: unknown; tools?: unknown; model?: unknown };
  const tools = Array.isArray(row.tools)
    ? row.tools.filter((name): name is string => typeof name === "string")
    : typeof row.tools === "string"
      ? row.tools.split(",")
      : [];
  const model = typeof row.model === "string" && MODEL_NAME.test(row.model) ? row.model : undefined;
  return {
    noChrome: row.noChrome === true,
    skipPermissions: row.skipPermissions === true,
    tools,
    ...(model ? { model } : {}),
  };
}

function denyTuiEnvKey(key: string): boolean {
  if (TUI_ENV_DENY_KEYS.has(key)) return true;
  if (TUI_ENV_DENY_PREFIXES.some((prefix) => key.startsWith(prefix))) return true;
  if (key.startsWith("CC_MODS_") && key !== "CC_MODS_SOCKET") return true;
  return false;
}

/** Mini user session plus Anthropic creds. Strip billing vars and relay internals only. */
export function buildSanitizedEnv(
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined || denyTuiEnvKey(key)) continue;
    env[key] = value;
  }
  env.TERM = PTY_NAME;
  env.COLORTERM = "truecolor";
  env.FORCE_COLOR = "3";
  env[TODO_TOOLS_ENV] ??= "1";
  return env;
}

export function assertSpawnEnvUntainted(env: Record<string, string | undefined>): void {
  const present = FORBIDDEN_BILLING_VARS.filter((key) => env[key] !== undefined);
  if (present.length > 0) {
    throw new Error(
      `engine-pty: refusing to spawn — forbidden billing var(s) survived sanitization: ` +
        `${present.join(", ")}. Inheriting these from the parent Node/ACP process would ` +
        `silently bill the run as credit instead of subscription (§10, R4).`,
    );
  }
}

export function resolveShell(baseEnv: Record<string, string | undefined> = process.env): string {
  return baseEnv.SHELL || "/bin/bash";
}

export function buildClaudeCmd(
  sessionId: string,
  permissionMode?: string,
  settingsFile?: string,
  effortLevel?: string,
  agent?: string,
  additionalDirectories?: string[],
  mcpConfigFile?: string,
  disallowedTools?: string[],
  appendSystemPromptFile?: string,
  extraFlags?: CcModsRelayFlags,
): string {
  let cmd = `claude --session-id ${sessionId}`;
  if (permissionMode && permissionMode !== "default") cmd += ` --permission-mode ${permissionMode}`;
  if (effortLevel && effortLevel !== "default") cmd += ` --effort ${effortLevel}`;
  if (agent && agent !== "default" && isSafeAgentRef(agent)) cmd += ` --agent "${agent}"`;
  if (settingsFile) cmd += ` --settings "${settingsFile}"`;
  cmd += buildAddDirFlags(additionalDirectories);
  if (mcpConfigFile) cmd += ` --mcp-config "${mcpConfigFile}"`;
  cmd += disallowedToolsFlag(disallowedTools);
  cmd += appendSystemPromptFileFlag(appendSystemPromptFile);
  cmd += extraClaudeFlags(extraFlags);
  debug("tui command", { cmd });
  return cmd;
}

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Isolated/mock TUI flags from initialize._meta.ccModsRelay. Production leaves these unset. */
export function extraClaudeFlags(flags: CcModsRelayFlags = {}): string {
  let out = "";
  if (flags.noChrome) out += " --no-chrome";
  if (flags.skipPermissions) out += " --dangerously-skip-permissions";
  const tools = (flags.tools ?? [])
    .map((name) => name.trim())
    .filter((name) => TOOL_NAME.test(name));
  if (tools.length) out += ` --tools ${tools.join(",")}`;
  if (flags.model && MODEL_NAME.test(flags.model)) out += ` --model ${flags.model}`;
  return out;
}

export function isSafeDir(p: string): boolean {
  return path.isAbsolute(p) && existsSync(p) && !/["$`\n\r]/.test(p);
}

export function buildAddDirFlags(additionalDirectories?: string[]): string {
  if (!additionalDirectories || additionalDirectories.length === 0) return "";
  let fragment = "";
  for (const dir of additionalDirectories) {
    if (isSafeDir(dir)) {
      fragment += ` --add-dir "${dir}"`;
    } else {
      console.error(
        `engine-pty: dropping unsafe --add-dir entry (not absolute+existing, or contains a shell ` +
          `metacharacter): ${JSON.stringify(dir)}`,
      );
    }
  }
  return fragment;
}

export function buildSpawnArgv(
  sessionId: string,
  permissionMode?: string,
  settingsFile?: string,
  effortLevel?: string,
  agent?: string,
  additionalDirectories?: string[],
  mcpConfigFile?: string,
  disallowedTools?: string[],
  appendSystemPromptFile?: string,
  extraFlags?: CcModsRelayFlags,
): [string, string] {
  return [
    "-c",
    buildClaudeCmd(
      sessionId,
      permissionMode,
      settingsFile,
      effortLevel,
      agent,
      additionalDirectories,
      mcpConfigFile,
      disallowedTools,
      appendSystemPromptFile,
      extraFlags,
    ),
  ];
}

export interface SpawnPtyOptions {
  cwd: string;
  sessionId?: string;
  baseEnv?: Record<string, string | undefined>;
  spawn?: TerminalSpawn;
  permissionMode?: string;
  effortLevel?: string;
  settingsFile?: string;
  agent?: string;
  additionalDirectories?: string[];
  mcpConfigFile?: string;
  disallowedTools?: string[];
  appendSystemPromptFile?: string;
  extraFlags?: CcModsRelayFlags;
}

export interface PtyEngineHandle {
  sessionId: string;
  pty: EngineTerminal;
}

export function spawnClaudePty(opts: SpawnPtyOptions): PtyEngineHandle {
  const {
    cwd,
    baseEnv = process.env,
    spawn = createHerdrSpawn({
      herdrSession: process.env.CLAUDE_TUI_HERDR_SESSION || "default",
    }),
    permissionMode,
    settingsFile,
    effortLevel,
    agent,
    additionalDirectories,
    mcpConfigFile,
    disallowedTools,
    appendSystemPromptFile,
    extraFlags,
  } = opts;

  const sessionId = opts.sessionId ?? randomUUID();
  const shell = resolveShell(baseEnv);
  const argv = buildSpawnArgv(
    sessionId,
    permissionMode,
    settingsFile,
    effortLevel,
    agent,
    additionalDirectories,
    mcpConfigFile,
    disallowedTools,
    appendSystemPromptFile,
    extraFlags,
  );

  const env = buildSanitizedEnv(baseEnv);

  assertSpawnEnvUntainted(env);

  const p = spawn(shell, argv, {
    name: PTY_NAME,
    cols: PTY_COLS,
    rows: PTY_ROWS,
    cwd,
    env: env as { [key: string]: string },
  });

  return { sessionId, pty: p };
}

export const SUBMISSION_DELAY_MS = 60;

export const CLEAR_INPUT_KEY = "\x15";

export const CLEAR_INPUT_DELAY_MS = 60;

export function sendPrompt(
  p: EngineTerminal,
  text: string,
  schedule: (fn: () => void, ms: number) => void = (fn, ms) => setTimeout(fn, ms),
): void {
  const payload = text.includes("\n") ? `\x1b[200~${text}\x1b[201~` : text;
  p.write("\x1b");
  schedule(() => p.write(CLEAR_INPUT_KEY), CLEAR_INPUT_DELAY_MS);
  schedule(() => p.write(payload), CLEAR_INPUT_DELAY_MS * 2);
  schedule(() => p.write("\r"), CLEAR_INPUT_DELAY_MS * 2 + SUBMISSION_DELAY_MS);
}
