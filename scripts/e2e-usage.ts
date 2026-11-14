/**
 * Live /usage over SSH: intercept should print Claude plan rate-limit windows.
 * Usage: bun scripts/e2e-usage.ts
 */
import { spawnLiveShim } from "./shim-client.js";

function liveEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || "haiku" };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  delete env.CC_MODS_MOCK;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDE_CODE_SIMPLE;
  return env;
}

async function main(): Promise<void> {
  const client = await spawnLiveShim(process.cwd(), liveEnv());
  console.error("[usage-e2e] shim connected");
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
      { cwd: process.cwd(), mcpServers: [] },
      90_000,
    );
    console.error(`[usage-e2e] session ${session.sessionId}`);
    const result = await client.request<{ stopReason: string }>(
      "session/prompt",
      { sessionId: session.sessionId, prompt: [{ type: "text", text: "/usage" }] },
      60_000,
    );
    const text = client.agentText();
    const ok =
      text.includes("Current session") &&
      /\d+% used/.test(text) &&
      (text.includes("Current week") || /Resets /.test(text));
    console.error(`[usage-e2e] stop=${result.stopReason} windows=${ok}`);
    if (!ok) {
      console.error("[usage-e2e] missing plan-limit copy");
      process.exitCode = 2;
    }
  } finally {
    await client.stop();
  }
}

await main();
