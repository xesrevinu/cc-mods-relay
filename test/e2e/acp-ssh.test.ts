import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { which } from "bun";
import { openRemote } from "../../src/client.js";
import { startMockAnthropic, toolResultsFromBody } from "../../src/mock-anthropic.js";
import { AcpTestClient } from "../acp-client.js";
import { MARKER, claudeBin, isolatedWorkspace, tuiEnv, tuiInitializeParams } from "../harness.js";

const TOOL_ID = "toolu_01ReadHelloTxtXXXXXX000000";

async function sshLocalhost(): Promise<boolean> {
  const proc = Bun.spawn(
    ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "-T", "localhost", "echo ok"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  return (await proc.exited) === 0 && out.includes("ok");
}

test("localhost ssh ACP tunnel forwards Read against the mock API", async () => {
  if (!claudeBin() || !which("herdr") || !(await sshLocalhost())) {
    console.warn("skip: claude, herdr, or ssh localhost is unavailable");
    return;
  }

  const dirs = isolatedWorkspace();
  mkdirSync(join(dirs.project, ".claude", "skills", "demo"), { recursive: true });
  writeFileSync(join(dirs.project, ".claude", "skills", "demo", "SKILL.md"), "# demo\n");

  const mock = startMockAnthropic([
    { blocks: [{ type: "tool_use", id: TOOL_ID, name: "Read", input: { file_path: "hello.txt" } }] },
    { blocks: [{ type: "text", text: "ssh-read-ok" }] },
  ]);
  const herdrSession = `cc-mods-ssh-${process.pid}-${Date.now()}`;
  const env = tuiEnv({
    mockUrl: mock.url,
    configDir: dirs.config,
    extra: {
      HOME: dirs.root,
      CLAUDE_TUI_BACKEND: "herdr",
      CLAUDE_TUI_HERDR_SESSION: herdrSession,
      CLAUDE_TUI_READY_TIMEOUT_MS: "45000",
    },
  });

  const opened = await openRemote("localhost", { cwd: dirs.project, env, inheritErr: false });
  const client = AcpTestClient.fromNode(opened.child);

  try {
    const init = await client.request<{ protocolVersion: number }>(
      "initialize",
      tuiInitializeParams(),
      45_000,
    );
    expect(init.protocolVersion).toBe(1);

    const session = await client.request<{ sessionId: string }>(
      "session/new",
      { cwd: dirs.project, mcpServers: [] },
      90_000,
    );
    expect(session.sessionId).toBeTruthy();

    const prompt = await client.request<{ stopReason: string }>(
      "session/prompt",
      { sessionId: session.sessionId, prompt: [{ type: "text", text: "Read hello.txt" }] },
      120_000,
    );
    expect(["end_turn", "max_tokens", "stop_sequence"]).toContain(prompt.stopReason);

    const results = mock.requests.flatMap((r) => toolResultsFromBody(r.body));
    const forwarded = results.find((r) => r.toolUseId === TOOL_ID);
    expect(forwarded, `Read not forwarded\nstderr:\n${client.stderr.slice(-3000)}\ntext:${client.agentText()}`).toBeDefined();
    expect(JSON.stringify(forwarded?.content)).toContain(MARKER);
    expect(client.agentText()).toContain("ssh-read-ok");
    expect(await Bun.file(join(opened.tuiRoot, ".claude", "skills", "demo", "SKILL.md")).text()).toContain("# demo");
    expect(await Bun.file(join(opened.tuiRoot, "AGENTS.md")).text()).toContain("# agents");
    expect(await Bun.file(join(opened.tuiRoot, "CLAUDE.md")).text()).toContain("use bun");
    expect(mock.url.startsWith("http://127.0.0.1:")).toBe(true);
  } finally {
    await client.stop();
    opened.relay.stop();
    mock.stop();
  }
}, 180_000);
