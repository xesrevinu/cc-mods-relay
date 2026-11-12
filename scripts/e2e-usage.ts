/**
 * Live /usage over SSH: intercept should print Claude plan rate-limit windows.
 * Usage: bun scripts/e2e-usage.ts
 */
import { openRemote } from "../src/client.js";
import { configuredHost } from "../src/config.js";
import { AcpTestClient } from "../test/acp-client.js";

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
  const host = (await configuredHost()) || "cc-remote";
  console.error(`[usage-e2e] host=${host}`);
  const opened = await openRemote(host, { cwd: process.cwd(), env: liveEnv(), inheritErr: true });
  const client = AcpTestClient.fromNode(opened.child);
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
    opened.relay.stop();
  }
}

await main();
