/**
 * Live SSH e2e: session/new → a real turn → /usage → /context (session/info) →
 * session/fork → session/load (inherited history) → session/info on the child,
 * plus a missing-id fork that must fail fast.
 *
 * Usage: bun scripts/e2e-session.ts
 */
import { openRemote } from "../src/client.js";
import { configuredHost } from "../src/config.js";
import { AcpTestClient } from "../test/acp-client.js";

function liveEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || "haiku",
  };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  delete env.CC_MODS_MOCK;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDE_CODE_SIMPLE;
  return env;
}

type ContextInfo = {
  result?: {
    sessionId?: string;
    context?: {
      used?: number;
      total?: number;
      systemPromptTokens?: number;
      messageTokens?: number;
      toolDefinitionsTokens?: number;
      freeTokens?: number;
      usagePct?: number;
    };
  };
  context?: {
    used?: number;
  };
};

function contextOf(info: ContextInfo): NonNullable<NonNullable<ContextInfo["result"]>["context"]> {
  return info.result?.context ?? info.context ?? {};
}

function chunkText(updates: Record<string, unknown>[]): string {
  return updates
    .flatMap((update) => {
      if (update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "user_message_chunk") {
        return [];
      }
      const content = update.content as { type?: string; text?: string } | undefined;
      return content?.type === "text" ? [content.text ?? ""] : [];
    })
    .join("");
}

async function main(): Promise<void> {
  const host = (await configuredHost()) || "cc-remote";
  console.error(`[session-e2e] host=${host}`);
  const opened = await openRemote(host, { cwd: process.cwd(), env: liveEnv(), inheritErr: true });
  const client = AcpTestClient.fromNode(opened.child);
  const failures: string[] = [];
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
    console.error(`[session-e2e] parent ${session.sessionId}`);

    const ping = await client.request<{ stopReason: string }>(
      "session/prompt",
      {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "Reply with exactly PONG42 and nothing else." }],
      },
      90_000,
    );
    const pingText = client.agentText();
    console.error(`[session-e2e] ping stop=${ping.stopReason} inherited=${/PONG42/i.test(pingText)}`);
    if (!/PONG42/i.test(pingText)) {
      failures.push("parent turn missing inherited marker");
    }

    const usage = await client.request<{ stopReason: string }>(
      "session/prompt",
      { sessionId: session.sessionId, prompt: [{ type: "text", text: "/usage" }] },
      60_000,
    );
    const usageText = client.agentText();
    const usageHasWindows = /\d+% used/.test(usageText) || usageText.includes("Current session");
    console.error(`[session-e2e] /usage stop=${usage.stopReason} windows=${usageHasWindows}`);
    if (!usageHasWindows) {
      failures.push("/usage missing plan-limit copy");
    }

    const info = await client.request<ContextInfo>(
      "_x.ai/session/info",
      { sessionId: session.sessionId },
      20_000,
    );
    const ctx = contextOf(info);
    const parentHasOccupancy =
      typeof ctx.used === "number" &&
      ctx.used >= 0 &&
      typeof ctx.systemPromptTokens === "number" &&
      ctx.systemPromptTokens > 0;
    console.error(`[session-e2e] parent context occupancy=${parentHasOccupancy}`);
    if (!(typeof ctx.used === "number") || ctx.used < 0) {
      failures.push("parent session/info missing used");
    }
    if (!(typeof ctx.systemPromptTokens === "number") || ctx.systemPromptTokens <= 0) {
      failures.push("parent session/info missing system prompt occupancy");
    }

    const missingStarted = Date.now();
    let missingMs = 0;
    try {
      await client.request(
        "session/fork",
        { sessionId: "00000000-0000-4000-8000-000000000000", cwd: process.cwd(), mcpServers: [] },
        5_000,
      );
      failures.push("fork of unknown id succeeded");
    } catch (err) {
      missingMs = Date.now() - missingStarted;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[session-e2e] missing-id fork failed in ${missingMs}ms: ${message.split("\n")[0]}`);
      if (!/not found/i.test(message)) failures.push(`missing-id fork: ${message.split("\n")[0]}`);
      if (missingMs > 4_000) failures.push(`missing-id fork took ${missingMs}ms`);
    }

    const forked = await client.request<{ sessionId: string }>(
      "session/fork",
      { sessionId: session.sessionId, cwd: process.cwd(), mcpServers: [] },
      90_000,
    );
    console.error(`[session-e2e] child ${forked.sessionId}`);
    if (!forked.sessionId || forked.sessionId === session.sessionId) {
      failures.push("fork did not return a new session id");
    }

    const beforeLoad = client.updates.length;
    await client.request(
      "session/load",
      { sessionId: forked.sessionId, cwd: process.cwd(), mcpServers: [] },
      30_000,
    );
    const replayed = chunkText(client.updates.slice(beforeLoad));
    const inherited = /PONG42/i.test(replayed) || /Reply with exactly PONG42/i.test(replayed);
    console.error(`[session-e2e] child load inherited=${inherited}`);
    if (!inherited) {
      failures.push("fork load missing inherited history");
    }

    const childInfo = await client.request<ContextInfo>(
      "_x.ai/session/info",
      { sessionId: forked.sessionId },
      20_000,
    );
    const childCtx = contextOf(childInfo);
    const childHasOccupancy =
      typeof childCtx.used === "number" &&
      childCtx.used >= 0 &&
      typeof childCtx.systemPromptTokens === "number" &&
      childCtx.systemPromptTokens > 0;
    console.error(`[session-e2e] child context occupancy=${childHasOccupancy}`);
    if (!(typeof childCtx.used === "number") || childCtx.used < 0) {
      failures.push("child session/info missing used");
    }
    if (!(typeof childCtx.systemPromptTokens === "number") || childCtx.systemPromptTokens <= 0) {
      failures.push("child session/info missing system prompt occupancy");
    }

    if (failures.length) {
      console.error(`[session-e2e] FAIL\n${failures.map((f) => `  - ${f}`).join("\n")}`);
      process.exitCode = 2;
    } else {
      console.error("[session-e2e] ok");
    }
  } finally {
    await client.stop();
    opened.relay.stop();
  }
}

await main();
