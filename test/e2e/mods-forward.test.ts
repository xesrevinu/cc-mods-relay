import { expect, test } from "bun:test";
import { join } from "node:path";
import { which } from "bun";
import { stagePlugin } from "../../src/launch.js";
import { applyModEvent } from "../../src/mod-live.js";
import { startModChannel } from "../../src/mod-channel.js";
import { startMockAnthropic, toolResultsFromBody, type ScriptedTurn } from "../../src/mock-anthropic.js";
import { startRelay } from "../../src/relay.js";
import { ACP_KIND, assertAcpNotification } from "../acp-schema.js";
import {
  MARKER,
  claudeBin,
  claudeEnv,
  isolatedWorkspace,
  runPrintClaude,
} from "../harness.js";

function toolId(name: string): string {
  return `toolu_01${name.replace(/[^A-Za-z]/g, "").padEnd(20, "X").slice(0, 20)}000000`;
}

function tuiPath(tui: string, name: string): string {
  return join(tui, name);
}

test("isolated Claude Code forwards every workspace tool and emits schema-valid ACP updates", async () => {
  const bin = claudeBin();
  if (!bin) {
    console.warn("skip: claude is not on PATH");
    return;
  }

  const dirs = isolatedWorkspace();
  const powershell = Boolean(which("pwsh") || which("powershell") || which("powershell.exe"));
  const tools: { name: string; input: Record<string, unknown>; check?: (result: unknown) => void }[] = [
    { name: "Read", input: { file_path: tuiPath(dirs.tui, "hello.txt") }, check: (r) => expect(JSON.stringify(r)).toContain(MARKER) },
    { name: "Glob", input: { pattern: "*.txt", path: dirs.tui }, check: (r) => expect(JSON.stringify(r)).toContain("hello.txt") },
    { name: "Grep", input: { pattern: MARKER, path: dirs.tui }, check: (r) => expect(JSON.stringify(r)).toContain("hello.txt") },
    {
      name: "NotebookEdit",
      input: {
        notebook_path: tuiPath(dirs.tui, "note.ipynb"),
        cell_id: "c1",
        new_source: "print(2)\n",
        edit_mode: "replace",
      },
    },
    { name: "Write", input: { file_path: tuiPath(dirs.tui, "created.txt"), content: "created-ok\n" } },
    { name: "Edit", input: { file_path: tuiPath(dirs.tui, "hello.txt"), old_string: MARKER, new_string: "edited-ok" } },
    { name: "Bash", input: { command: "echo bash-ok" }, check: (r) => expect(JSON.stringify(r)).toContain("bash-ok") },
  ];
  if (powershell) {
    tools.push({
      name: "PowerShell",
      input: { command: "Write-Output 'ps-ok'" },
      check: (r) => expect(JSON.stringify(r)).toContain("ps-ok"),
    });
  }

  const turns: ScriptedTurn[] = [
    ...tools.map((t) => ({
      blocks: [{ type: "tool_use" as const, id: toolId(t.name), name: t.name, input: t.input }],
    })),
    { blocks: [{ type: "text", text: "all-tools-done" }] },
  ];

  const mock = startMockAnthropic(turns);
  const relay = startRelay();
  relay.bind("iso", dirs.project, dirs.tui);
  const calls: { tool?: string; cwd?: string; tuiRoot?: string }[] = [];
  relay.onTool((frame) => calls.push(frame));
  const channel = startModChannel();
  const acp: unknown[] = [];
  const acpTools = new Map<string, { tool: string; input: Record<string, unknown> }>();
  const acpClient = {
    sessionUpdate: async (note: any) => {
      assertAcpNotification(note);
      acp.push(note.update);
    },
  };
  const pendingAcp: Promise<void>[] = [];
  channel.onEvent((event) => {
    pendingAcp.push(
      applyModEvent("iso", event, { client: acpClient, tools: acpTools, cwd: dirs.project, supportsTerminal: false }).then(() => {}),
    );
  });
  const pluginDir = await stagePlugin({
    url: relay.url,
    token: relay.token,
    cwd: dirs.project,
    tuiRoot: dirs.tui,
  });

  try {
    const ran = await runPrintClaude({
      bin,
      cwd: dirs.tui,
      pluginDir,
      env: claudeEnv({
        mockUrl: mock.url,
        configDir: dirs.config,
        extra: { CC_MODS_SOCKET: channel.path },
      }),
      extraArgs: ["--tools", tools.map((t) => t.name).join(",")],
      prompt: "Use the workspace tools as scripted.",
      timeoutMs: 90_000,
    });
    if (ran.code !== 0) {
      throw new Error(
        `claude -p exited ${ran.code}\nstdout:\n${ran.stdout}\nstderr:\n${ran.stderr}\n` +
          `requests: ${JSON.stringify(mock.requests.map((r) => ({ path: r.path, cls: r.requestClass })), null, 2)}`,
      );
    }

    await Promise.all(pendingAcp);
    const advertised = ((mock.requests[0]?.body as { tools?: { name?: string }[] } | undefined)?.tools ?? [])
      .map((t) => t.name)
      .filter(Boolean);
    const results = mock.requests.flatMap((r) => toolResultsFromBody(r.body));
    const seen = calls.map((c) => c.tool);
    for (const t of tools) {
      if (!calls.some((c) => c.tool === t.name)) {
        throw new Error(
          `missing ${t.name}\nrelay: ${JSON.stringify(seen)}\nadvertised: ${JSON.stringify(advertised)}\n` +
            `stdout: ${ran.stdout.slice(0, 1500)}\n` +
            `tool_results: ${results.map((r) => r.toolUseId).join(",")}`,
        );
      }
      const forwarded = results.find((r) => r.toolUseId === toolId(t.name));
      expect(forwarded, t.name).toBeDefined();
      t.check?.(forwarded?.content);
      const started = acp.find((u: any) => u.sessionUpdate === "tool_call" && u.toolCallId === toolId(t.name)) as any;
      expect(started, `${t.name} acp`).toMatchObject({
        name: t.name,
        kind: ACP_KIND[t.name as keyof typeof ACP_KIND],
        status: "pending",
      });
      expect(
        acp.some((u: any) => u.sessionUpdate === "tool_call_update" && u.toolCallId === toolId(t.name) && u.status === "completed"),
        `${t.name} completed`,
      ).toBe(true);
    }

    expect(calls.every((c) => c.cwd === dirs.project && c.tuiRoot === dirs.tui)).toBe(true);
    expect(await Bun.file(join(dirs.project, "created.txt")).text()).toBe("created-ok\n");
    expect(await Bun.file(join(dirs.project, "hello.txt")).text()).toContain("edited-ok");
    expect(await Bun.file(join(dirs.project, "note.ipynb")).text()).toContain("print(2)");
    expect(ran.stdout).toContain("all-tools-done");
    if (!powershell) expect(tools.some((t) => t.name === "PowerShell")).toBe(false);
  } finally {
    mock.stop();
    relay.stop();
    channel.stop();
  }
}, 120_000);
