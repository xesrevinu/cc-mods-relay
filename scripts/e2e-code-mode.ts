/**
 * Live Code Mode e2e: Mini TUI should run a REPL script whose inner
 * Read/Glob/Grep/Bash calls still execute on this machine.
 *
 * Usage: bun scripts/e2e-code-mode.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnLiveShim } from "./shim-client.js";
import { AcpTestClient } from "../test/acp-client.js";

const DEBUG_FILE = process.env.CC_MODS_DEBUG_FILE || "/tmp/cc-mods-code-mode.log";
const PROMPT = [
  "Use Code Mode. In a single script, start ALL of these at the same time with Promise.all — do not await them one after another:",
  "- Read README.md",
  "- Read docs/guide.md",
  "- Read AGENTS.md",
  "- Read exists.txt",
  "- Read gone.md",
  "- Read missing-file.ts",
  "After they all finish, list which of those local paths are missing. Do not ask questions.",
].join("\n");

function liveEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || "haiku",
    CC_MODS_DEBUG: "1",
    CC_MODS_DEBUG_FILE: DEBUG_FILE,
  };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  delete env.CC_MODS_MOCK;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDE_CODE_SIMPLE;
  delete env.DISABLE_TELEMETRY;
  return env;
}

function fixture(): string {
  const dir = join(homedir(), "Workspace", "tmp-cc-mods-code-mode");
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(
    join(dir, "README.md"),
    "# Demo\n\nSee [exists](./exists.txt) and [missing](./gone.md).\n",
  );
  writeFileSync(join(dir, "docs", "guide.md"), "Also [nope](../missing-file.ts).\n");
  writeFileSync(join(dir, "exists.txt"), "hello\n");
  writeFileSync(join(dir, "AGENTS.md"), "# agents\n");
  return dir;
}

function maxWsInflight(log: string): { max: number; waves: string[][] } {
  let inflight: string[] = [];
  let max = 0;
  const waves: string[][] = [];
  for (const line of log.split("\n")) {
    const started = line.match(/\[cc-mods\] ws call .*?"tool":"([^"]+)"/);
    if (started) {
      inflight.push(started[1]!);
      if (inflight.length > max) max = inflight.length;
      if (inflight.length > 1) waves.push([...inflight]);
      continue;
    }
    if (/\[cc-mods\] ws result /.test(line) && inflight.length) inflight.shift();
  }
  return { max, waves };
}

function updateText(update: Record<string, unknown>): string {
  const content = update.content;
  if (!Array.isArray(content)) return typeof update.title === "string" ? update.title : "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const inner = (block as { content?: { text?: string } }).content;
      return typeof inner?.text === "string" ? inner.text : "";
    })
    .join("\n");
}

type Call = { name: string; parent?: string; title?: string };

function toolCalls(client: AcpTestClient): Call[] {
  const out: Call[] = [];
  for (const update of client.updates) {
    if (update.sessionUpdate !== "tool_call") continue;
    const meta = update._meta as { claudeCode?: { parentToolUseId?: string; toolName?: string } } | undefined;
    const name =
      typeof update.name === "string"
        ? update.name
        : typeof meta?.claudeCode?.toolName === "string"
          ? meta.claudeCode.toolName
          : update.title === "Code"
            ? "REPL"
            : undefined;
    if (!name) continue;
    const parent = meta?.claudeCode?.parentToolUseId;
    out.push({
      name,
      ...(typeof parent === "string" ? { parent } : {}),
      ...(typeof update.title === "string" ? { title: update.title } : {}),
    });
  }
  return out;
}

async function main(): Promise<void> {
  process.env.CC_MODS_DEBUG = "1";
  process.env.CC_MODS_DEBUG_FILE = DEBUG_FILE;
  await Bun.write(DEBUG_FILE, "");
  const cwd = fixture();
  console.error(`[code-mode-e2e] cwd=${cwd}`);
  console.error(`[code-mode-e2e] debug=${DEBUG_FILE}`);

  const client = await spawnLiveShim(cwd, liveEnv());
  try {
    await client.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        _meta: { ccModsRelay: { noChrome: true, skipPermissions: true, model: "haiku" } },
      },
      45_000,
    );
    const session = await client.request<{ sessionId: string }>(
      "session/new",
      { cwd, mcpServers: [] },
      120_000,
    );
    console.error(`[code-mode-e2e] session ${session.sessionId}`);
    // Caveats skip the first-run restart. Still wait until the Mac sees the
    // plugin hello so a slow TUI does not drop the first prompt.
    const helloDeadline = Date.now() + 25_000;
    while (Date.now() < helloDeadline) {
      const log = await Bun.file(DEBUG_FILE).text().catch(() => "");
      if (/ws hello|plugin hello/.test(log)) break;
      await Bun.sleep(250);
    }

    const before = client.updates.length;
    const sent = Date.now();
    const result = await client.request<{ stopReason: string }>(
      "session/prompt",
      { sessionId: session.sessionId, prompt: [{ type: "text", text: PROMPT }] },
      240_000,
    );
    const elapsed = Date.now() - sent;
    console.error(`[code-mode-e2e] session/prompt returned in ${Math.round(elapsed / 1000)}s`);
    const kinds = [...new Set(client.updates.slice(before).map((u) => String(u.sessionUpdate)))];
    console.error(`[code-mode-e2e] update kinds=${JSON.stringify(kinds)}`);
    const calls = toolCalls(client);
    const names = [...new Set(calls.map((call) => call.name))];
    const debugLog = await Bun.file(DEBUG_FILE).text().catch(() => "");
    const wsTools = [...debugLog.matchAll(/\[cc-mods\] ws call .*?"tool":"([^"]+)"/g)].map((m) => m[1]!);
    const overlap = maxWsInflight(debugLog);
    const tuiCmd = debugLog.match(/\[cc-mods\] tui command (\{.*\})/)?.[1];
    const text = client.agentText();

    console.error(`[code-mode-e2e] stop=${result.stopReason}`);
    console.error(`[code-mode-e2e] acp tools=${JSON.stringify(names)}`);
    console.error(`[code-mode-e2e] acp calls=${JSON.stringify(calls)}`);
    console.error(`[code-mode-e2e] ws tools=${JSON.stringify([...new Set(wsTools)])}`);
    console.error(`[code-mode-e2e] ws inflight max=${overlap.max} waves=${JSON.stringify(overlap.waves.slice(0, 8))}`);
    if (tuiCmd) console.error(`[code-mode-e2e] tui command=${tuiCmd}`);
    console.error(`[code-mode-e2e] text:\n${text.slice(-2000)}`);
    if (client.stderr.trim()) console.error(`[code-mode-e2e] shim stderr:\n${client.stderr.slice(-2000)}`);

    const repl = names.includes("REPL");
    const inner = ["Read", "Glob", "Grep", "Bash"].filter((name) => names.includes(name) || wsTools.includes(name));
    const mentioned = /gone\.md|missing-file\.ts/i.test(text);
    if (!repl) {
      throw new Error(
        `Code Mode did not emit REPL (acp=${names.join(",") || "none"}; inner=${inner.join(",") || "none"})`,
      );
    }
    if (!inner.length) {
      throw new Error("REPL ran but no inner workspace tools reached ACP or the Mac executor");
    }
    if (!wsTools.some((name) => ["Read", "Glob", "Grep", "Bash"].includes(name))) {
      throw new Error(`inner tools did not execute on this machine (ws=${wsTools.join(",") || "none"})`);
    }
    if (!mentioned) {
      throw new Error("turn finished without naming the missing local links");
    }
    const failed = client.updates.filter((u) => u.sessionUpdate === "tool_call_update" && u.status === "failed");
    const failedBlob = failed.map((u) => updateText(u)).join("\n");
    console.error(`[code-mode-e2e] failed tools=${failed.length} text=${JSON.stringify(failedBlob.slice(0, 800))}`);
    if (/permission denied|Denied by the ACP client/i.test(failedBlob) || /permission denied|Denied by the ACP client/i.test(text)) {
      throw new Error(`missing Reads were mapped as permission denied\nACP failed:\n${failedBlob.slice(-1500)}\ntext:\n${text.slice(-1500)}`);
    }
    if (!/does not exist|ENOENT|no such file/i.test(`${failedBlob}\n${text}`)) {
      throw new Error("missing Reads did not surface as a file-not-found tool error");
    }
    if (/read returned content|reported all six as present/i.test(text)) {
      throw new Error("REPL still treated missing Reads as successful file content");
    }
    if (overlap.max < 2) {
      throw new Error("Code Mode did not overlap inner tool calls on this machine (ws calls were serial)");
    }
    console.error(
      `[code-mode-e2e] OK repl=1 inner=${inner.join(",")} ws=${[...new Set(wsTools)].join(",")} parallel=${overlap.max}`,
    );
  } finally {
    await client.stop();
  }
}

await main();
