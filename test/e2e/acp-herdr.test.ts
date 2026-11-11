import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { which } from "bun";
import { prepareLocal } from "../../src/client.js";
import { startMockAnthropic, toolResultsFromBody } from "../../src/mock-anthropic.js";
import { AcpTestClient } from "../acp-client.js";
import { MARKER, claudeBin, isolatedWorkspace, tuiEnv, tuiInitializeParams } from "../harness.js";

const AGENT = join(import.meta.dir, "../../src/agent.ts");
const TOOL_ID = "toolu_01ReadHelloTxtXXXXXX000000";

test("herdr TUI ACP handshake forwards Read through Mods to the mock API", async () => {
  if (!claudeBin() || !which("herdr")) {
    console.warn("skip: claude or herdr is not on PATH");
    return;
  }

  const dirs = isolatedWorkspace();
  mkdirSync(join(dirs.root, "herdr-home"));
  const mock = startMockAnthropic([
    { blocks: [{ type: "tool_use", id: TOOL_ID, name: "Read", input: { file_path: join(dirs.tui, "hello.txt") } }] },
    { blocks: [{ type: "text", text: "herdr-read-ok" }] },
  ]);
  const herdrSession = `cc-mods-test-${process.pid}-${Date.now()}`;
  const env = tuiEnv({
    mockUrl: mock.url,
    configDir: dirs.config,
    extra: {
      HOME: dirs.root,
      CLAUDE_TUI_BACKEND: "herdr",
      CLAUDE_TUI_HERDR_SESSION: herdrSession,
      CLAUDE_TUI_HERDR_HOME: join(dirs.root, "herdr-home"),
      CLAUDE_TUI_READY_TIMEOUT_MS: "45000",
    },
  });
  const { relay, pluginDir } = await prepareLocal(dirs.project, dirs.tui);
  const client = AcpTestClient.spawn(["bun", AGENT, "--plugin-dir", pluginDir], { cwd: dirs.tui, env });

  try {
    const init = await client.request<{ protocolVersion: number }>(
      "initialize",
      tuiInitializeParams(),
      30_000,
    );
    expect(init.protocolVersion).toBe(1);

    const session = await client.request<{ sessionId: string }>(
      "session/new",
      { cwd: dirs.tui, mcpServers: [] },
      90_000,
    );
    expect(session.sessionId).toBeTruthy();

    const pluginConnected = await relay.waitUntilReady(8_000).then(() => true).catch(() => false);

    const prompt = await client.request<{ stopReason: string }>(
      "session/prompt",
      { sessionId: session.sessionId, prompt: [{ type: "text", text: "Read hello.txt" }] },
      120_000,
    ).catch((err) => {
      throw new Error(
        `${err instanceof Error ? err.message : err}\npluginConnected=${pluginConnected}\nupdates=${JSON.stringify(client.updates).slice(0, 2000)}\npermissions=${client.permissions.length}\nmock=${JSON.stringify(mock.requests.map((r) => ({ path: r.path, cls: r.requestClass })))}`,
      );
    });
    expect(["end_turn", "max_tokens", "stop_sequence"]).toContain(prompt.stopReason);

    const results = mock.requests.flatMap((r) => toolResultsFromBody(r.body));
    const forwarded = results.find((r) => r.toolUseId === TOOL_ID);
    expect(forwarded, `Read not forwarded\nstderr:\n${client.stderr.slice(-3000)}\ntext:${client.agentText()}`).toBeDefined();
    expect(JSON.stringify(forwarded?.content)).toContain(MARKER);
    expect(client.agentText()).toContain("herdr-read-ok");
    expect(
      client.updates.some((u) => u.sessionUpdate === "tool_call" && u.toolCallId === TOOL_ID),
    ).toBe(true);
    expect(mock.requests.every((r) => r.path.startsWith("/v1/") || r.path === "/api/hello")).toBe(true);

    await client.request("session/close", { sessionId: session.sessionId }, 15_000);
  } finally {
    await client.stop();
    relay.stop();
    mock.stop();
  }
}, 180_000);
