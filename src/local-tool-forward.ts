import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClaudeMcpConfig, ClaudeMcpEntry } from "./mcp-config-writer.js";

export const DEFAULT_DISALLOWED_BUILTINS: readonly string[] = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "NotebookEdit",
  "Bash",
  "PowerShell",
  "LSP",
  "Monitor",
  "EnterWorktree",
  "ExitWorktree",
];

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

export const DEFAULT_REQUIRED_FORWARD_TOOLS: readonly string[] = ["Read", "Bash"];

export const UNREPLACED_FORWARD_TOOLS: readonly string[] = [
  "LSP",
  "Monitor",
  "EnterWorktree",
  "ExitWorktree",
];

const REPLACEMENT_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "NotebookEdit",
  "Bash",
  "PowerShell",
]);

export type LocalToolForwardOptions = {
  enabled?: boolean;
  disallowedTools?: string[];
  requiredTools?: string[];
  providedTools?: Record<string, string[]>;
};

export type LocalToolForwardMeta = {
  claudeCode?: {
    localToolForward?: boolean | LocalToolForwardOptions;
  };
} | null | undefined;

export type ForwardingMcpServer = { name: string; tools: string[] };

export function isLocalToolForwardEnabled(
  env: NodeJS.ProcessEnv = process.env,
  meta?: LocalToolForwardMeta,
): boolean {
  const raw = meta?.claudeCode?.localToolForward;
  const fromMeta =
    raw === true || (raw !== null && typeof raw === "object" && raw.enabled === true);
  const v = env.CLAUDE_TUI_LOCAL_TOOL_FORWARD?.trim().toLowerCase();
  const fromEnv = v === "1" || v === "on" || v === "true";
  if (fromMeta || fromEnv) {
    console.error(
      "cc-mods-relay: CLAUDE_TUI_LOCAL_TOOL_FORWARD is ignored; workspace tools go through Mods intercept",
    );
  }
  return false;
}

export function sanitizeToolNames(names: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of names ?? []) {
    if (!TOOL_NAME.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function resolveDisallowedBuiltins(meta?: LocalToolForwardMeta): string[] {
  const raw = meta?.claudeCode?.localToolForward;
  const extra = raw && typeof raw === "object" ? raw.disallowedTools : undefined;
  return sanitizeToolNames([...DEFAULT_DISALLOWED_BUILTINS, ...(extra ?? [])]);
}

export function stdioMcpServerNames(config: ClaudeMcpConfig): string[] {
  return Object.entries(config.mcpServers ?? {})
    .filter(([, entry]) => isStdioEntry(entry))
    .map(([name]) => name);
}

function isStdioEntry(entry: ClaudeMcpEntry | undefined): entry is { command: string; args?: string[]; env?: Record<string, string> } {
  return !!entry && "command" in entry && typeof entry.command === "string" && entry.command.length > 0;
}

export function assertForwardingStdioMcp(config: ClaudeMcpConfig): void {
  if (stdioMcpServerNames(config).length === 0) {
    throw new Error(
      "local tool forwarding is enabled but no stdio MCP server was provided. " +
        "Pass at least one stdio MCP server (for example a local workspace server; " +
        'the reserved name "workspace" is remapped to "localws") so file/shell tools ' +
        "have a local replacement. Refusing to start with built-in tools disabled " +
        "and no replacement (and not falling back to host built-ins).",
    );
  }
}

export function resolveRequiredForwardTools(meta?: LocalToolForwardMeta): string[] {
  const raw = meta?.claudeCode?.localToolForward;
  const named = raw && typeof raw === "object" ? raw.requiredTools : undefined;
  const sanitized = sanitizeToolNames(named);
  return sanitized.length ? sanitized : [...DEFAULT_REQUIRED_FORWARD_TOOLS];
}

export function providedToolsFromMeta(meta?: LocalToolForwardMeta): Record<string, string[]> | undefined {
  const raw = meta?.claudeCode?.localToolForward;
  if (!raw || typeof raw !== "object" || raw.providedTools == null) return undefined;
  const out: Record<string, string[]> = {};
  for (const [name, tools] of Object.entries(raw.providedTools)) {
    const mapped = name === "workspace" ? "localws" : name;
    out[mapped] = sanitizeToolNames(tools ?? []);
  }
  return out;
}

export function selectForwardingMcpServers(
  mcpServerNames: readonly string[],
  providedTools: Record<string, string[]>,
): ForwardingMcpServer[] {
  const out: ForwardingMcpServer[] = [];
  for (const name of mcpServerNames) {
    if (!TOOL_NAME.test(name)) continue;
    const tools = sanitizeToolNames(providedTools[name] ?? []).filter((t) => REPLACEMENT_TOOLS.has(t));
    if (tools.length) out.push({ name, tools });
  }
  return out;
}

export function assertForwardingToolCoverage(opts: {
  requiredTools: readonly string[];
  providedTools: Record<string, string[]>;
  mcpServerNames: readonly string[];
}): void {
  const required = sanitizeToolNames(opts.requiredTools);
  const union = new Set<string>();
  const inspected: string[] = [];
  for (const name of opts.mcpServerNames) {
    const tools = opts.providedTools[name];
    if (!tools) continue;
    inspected.push(name);
    for (const t of tools) union.add(t);
  }
  const missing = required.filter((t) => !union.has(t));
  if (missing.length === 0) return;
  const inspectedNote = inspected.length ? inspected.join(", ") : "(none with a tool list)";
  throw new Error(
    "local tool forwarding is enabled but the configured stdio MCP server(s) do not expose " +
      `the required tools: ${missing.join(", ")}. Inspected server(s): ${inspectedNote}. ` +
      "Pass a workspace stdio MCP that implements those tools (for example localws-mcp), " +
      "or declare them in _meta.claudeCode.localToolForward.providedTools. " +
      "Refusing to disable built-in Read/Bash (and other file/shell tools) against an unrelated MCP " +
      "(and not falling back to host built-ins).",
  );
}

export async function probeStdioMcpTools(
  entry: { command: string; args?: string[]; env?: Record<string, string> },
  timeoutMs = 4000,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const child = spawn(entry.command, entry.args ?? [], {
      env: { ...process.env, ...(entry.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { } }, 200);
      finish(() => reject(new Error(`tools/list probe timed out after ${timeoutMs}ms${stderr ? `: ${stderr.slice(0, 200)}` : ""}`)));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
      const lines = stdout.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const msg = JSON.parse(trimmed);
          const tools = msg?.result?.tools;
          if (msg.id === 2 && Array.isArray(tools)) {
            clearTimeout(timer);
            try { child.kill("SIGTERM"); } catch { }
            finish(() => resolve(tools.map((t: { name?: string }) => t.name).filter((n: unknown): n is string => typeof n === "string")));
          }
        } catch {
        }
      }
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      finish(() => reject(new Error(`failed to start stdio MCP (${entry.command}): ${err.message}`)));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(() => reject(new Error(`stdio MCP exited before tools/list (code ${code})${stderr ? `: ${stderr.slice(0, 200)}` : ""}`)));
    });
    const send = (obj: unknown) => child.stdin.write(JSON.stringify(obj) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-tui-forward-probe", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  });
}

export async function resolveForwardingCoverage(
  config: ClaudeMcpConfig,
  meta?: LocalToolForwardMeta,
): Promise<{ servers: ForwardingMcpServer[]; requiredTools: string[]; providedTools: Record<string, string[]> }> {
  const requiredTools = resolveRequiredForwardTools(meta);
  const names = stdioMcpServerNames(config);
  let providedTools = providedToolsFromMeta(meta);
  if (!providedTools) {
    providedTools = {};
    for (const name of names) {
      const entry = config.mcpServers[name];
      if (!isStdioEntry(entry)) continue;
      try {
        providedTools[name] = await probeStdioMcpTools(entry);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `local tool forwarding: could not list tools from stdio MCP server "${name}": ${detail}. ` +
            `Pass _meta.claudeCode.localToolForward.providedTools or a reachable workspace server ` +
            `that exposes ${requiredTools.join(", ")}. Refusing to disable built-in tools.`,
        );
      }
    }
  }
  assertForwardingToolCoverage({ requiredTools, providedTools, mcpServerNames: names });
  return { servers: selectForwardingMcpServers(names, providedTools), requiredTools, providedTools };
}

export function buildLocalEnvironmentAppend(opts: {
  cwd: string;
  mcpServerNames?: readonly string[];
  servers?: readonly ForwardingMcpServer[];
  unreplacedTools?: readonly string[];
}): string {
  const servers =
    opts.servers?.filter((s) => TOOL_NAME.test(s.name) && s.tools.length > 0) ??
    [];
  const examples = servers
    .map((s) => s.tools.map((t) => `mcp__${s.name}__${t}`).join(", "))
    .join("; ");
  const unreplaced = (opts.unreplacedTools ?? UNREPLACED_FORWARD_TOOLS).join(", ");
  return [
    "# Local workspace environment",
    "",
    "This note is appended to Claude Code's default system prompt and does not replace it.",
    "",
    `Working directory: ${opts.cwd}`,
    "",
    "File and shell work for this workspace must use the local MCP workspace tools.",
    "Those tools run on the user's machine, not necessarily on the host running this TUI.",
    servers.length
      ? `Local MCP server(s) with file/shell replacements: ${servers.map((s) => s.name).join(", ")}. Tools: ${examples}.`
      : "A local MCP workspace server exposing Read and Bash is required for file and shell work.",
    "Do not ask the user to name or invoke these tools; use them when the task needs them.",
    "",
    `The following built-in tools are disabled and are not replaced by the local MCP: ${unreplaced}. ` +
      "This is an explicit capability degradation, not an equivalent substitute.",
    "",
  ].join("\n");
}

export async function writeAppendSystemPromptFile(text: string): Promise<string> {
  const filePath = path.join(os.tmpdir(), `fork-acp-append-sys-${randomUUID()}.txt`);
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, text.endsWith("\n") ? text : `${text}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, filePath);
    await fs.chmod(filePath, 0o600);
    return filePath;
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    await fs.rm(filePath, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function removeAppendSystemPromptFile(filePath: string | undefined): Promise<void> {
  if (!filePath) return;
  await fs.rm(filePath, { force: true }).catch(() => undefined);
}

export function disallowedToolsFlag(names: readonly string[] | undefined): string {
  const safe = sanitizeToolNames(names);
  if (safe.length === 0) return "";
  return ` --disallowed-tools "${safe.join(",")}"`;
}

export function appendSystemPromptFileFlag(filePath: string | undefined): string {
  if (!filePath) return "";
  if (/["`$\\;\n\r]/.test(filePath)) {
    throw new Error(
      `local tool forwarding: append-system-prompt-file path contains unsafe characters: ${filePath}`,
    );
  }
  return ` --append-system-prompt-file "${filePath}"`;
}
