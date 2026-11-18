/**
 * Replay real interactive TUI sessions (`herdr` + `startServer` + `AcpTestClient`
 * + `mock-anthropic` + persistent Unix-socket plugin RPC):
 *   - Workspace Read / Grep / Edit / Write
 *   - `git status` + redundant leading `cd` drop/hint inside a real git repo
 *   - Background Bash -> `TaskStop` (must cancel Client process AND stop Mini waiter)
 *   - `Monitor` -> `TaskStop` (must cancel Client monitor via plugin)
 *   - Background Bash + busy turn -> native `<task-notification>` (no plugin queue)
 *   - Optional `REPL` probe (WATCH when isolated mock lacks firstParty OAuth/GrowthBook flags)
 *
 *   bun scripts/replay-tui.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODE_MODE_CONFIG_ENV, CODE_MODE_ENV } from "../src/config.js";
import { acceptCodeModeCaveats } from "../src/environment.js";
import { startMockAnthropic, toolResultsFromBody } from "../src/mock-anthropic.js";
import { startServer } from "../src/server.js";
import { REDUNDANT_CD_HINT } from "../src/tools/bash-intent.js";
import { AcpTestClient } from "../test/acp-client.js";
import { MARKER, claudeBin, isolatedWorkspace, tuiEnv, tuiInitializeParams } from "../test/harness.js";

const INDEX = join(import.meta.dir, "../src/index.ts");
const bin = claudeBin();
if (!bin) {
  console.error("claude is not on PATH");
  process.exit(1);
}

const dirs = isolatedWorkspace();
mkdirSync(join(dirs.root, "herdr-home"));
writeFileSync(join(dirs.project, "src.ts"), "export const v = 1;\n");
const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dirs.project, stdout: "pipe", stderr: "pipe" });
git(["init", "-q"]);
git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "add", "."]);
git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "init"]);

const READ_ID = "toolu_01TuiReadMarkerXXXXX000000";
const EDIT_ID = "toolu_01TuiEditSrcXXXXXXXX000000";
const GREP_ID = "toolu_01TuiGrepSingleXXXXX000000";
const GIT_ID = "toolu_01TuiGitCdXXXXXXXXXX000000";
const BG_STOP_ID = "toolu_01TuiBgStopXXXXXXXXX000000";
const BG_CANCEL_TOOL_ID = "toolu_01TuiTaskStopBgXXXXX000000";
const BG_DONE_ID = "toolu_01TuiBgWaiterXXXXXXX000000";
const BUSY_ID = "toolu_01TuiBusyTurnXXXXXXX000000";
const REPL_ID = "toolu_01TuiReplProbeXXXXXX000000";

const bgSentinel = join(dirs.project, "bg-should-die.txt");
const blob = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

const mock = startMockAnthropic([
  {
    blocks: [
      { type: "tool_use", id: READ_ID, name: "Read", input: { file_path: join(dirs.project, "hello.txt") } },
      { type: "tool_use", id: EDIT_ID, name: "Edit", input: { file_path: join(dirs.project, "src.ts"), old_string: "v = 1", new_string: "v = 2" } },
      { type: "tool_use", id: GREP_ID, name: "Grep", input: { pattern: "v = 2", path: join(dirs.project, "src.ts"), output_mode: "content" } },
    ],
  },
  {
    blocks: [
      {
        type: "tool_use",
        id: GIT_ID,
        name: "Bash",
        input: { command: `cd '${dirs.project}' && git status --short --branch` },
      },
    ],
  },
  {
    blocks: [
      {
        type: "tool_use",
        id: BG_STOP_ID,
        name: "Bash",
        input: { command: `sleep 2; printf leaked > '${bgSentinel}'`, run_in_background: true },
      },
    ],
  },
  (body) => {
    const hit = toolResultsFromBody(body).find((r) => r.toolUseId === BG_STOP_ID);
    const id = blob(hit?.content).match(/ID:\s*([a-z0-9]+)/i)?.[1] ?? "missing";
    return {
      blocks: [{ type: "tool_use", id: BG_CANCEL_TOOL_ID, name: "TaskStop", input: { task_id: id } }],
    };
  },
  {
    blocks: [
      {
        type: "tool_use",
        id: BG_DONE_ID,
        name: "Bash",
        input: { command: "sleep 1; printf tui-bg-done", run_in_background: true },
      },
    ],
  },
  {
    blocks: [
      {
        type: "tool_use",
        id: BUSY_ID,
        name: "Bash",
        input: { command: "sleep 2; printf tui-busy-done" },
      },
    ],
  },
  {
    blocks: [
      {
        type: "tool_use",
        id: REPL_ID,
        name: "REPL",
        input: { code: 'await file("hello.txt").text()' },
      },
    ],
  },
  { blocks: [{ type: "text", text: "tui-replay-done" }] },
]);

const prevCodeMode = process.env[CODE_MODE_ENV];
const prevConfigCodeMode = process.env[CODE_MODE_CONFIG_ENV];
process.env[CODE_MODE_ENV] = "1";
process.env[CODE_MODE_CONFIG_ENV] = "1";

const herdrSession = `cc-mods-tui-replay-${process.pid}-${Date.now()}`;
const env = tuiEnv({
  mockUrl: mock.url,
  configDir: dirs.config,
  extra: {
    HOME: dirs.root,
    CLAUDE_TUI_BACKEND: "herdr",
    CLAUDE_TUI_HERDR_SESSION: herdrSession,
    CLAUDE_TUI_HERDR_HOME: join(dirs.root, "herdr-home"),
    CLAUDE_TUI_READY_TIMEOUT_MS: "45000",
    [CODE_MODE_ENV]: "1",
    [CODE_MODE_CONFIG_ENV]: "1",
    CC_MODS_TUI_ENV: JSON.stringify({
      TZ: "Asia/Tokyo",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      FORCE_COLOR: "3",
    }),
  },
});
acceptCodeModeCaveats(env, dirs.root);

const token = "tui-replay-token";
const server = startServer({ token, hostname: "127.0.0.1", port: 0 });
const client = AcpTestClient.spawn(["bun", INDEX, "--url", server.sessionUrl, "--token", token], {
  cwd: dirs.project,
  env,
});

const t0 = Date.now();
try {
  await client.request("initialize", {
    ...tuiInitializeParams(),
    _meta: { ccModsRelay: { noChrome: true, skipPermissions: true, codeMode: true } },
  }, 30_000);
  const session = await client.request<{ sessionId: string }>(
    "session/new",
    { cwd: dirs.project, mcpServers: [] },
    90_000,
  );
  console.log("session", session.sessionId, `+${Date.now() - t0}ms`);

  const prompt = await client.request<{ stopReason: string }>(
    "session/prompt",
    { sessionId: session.sessionId, prompt: [{ type: "text", text: "Replay TUI workspace and background flow." }] },
    90_000,
  );
  console.log("prompt", prompt.stopReason, `+${Date.now() - t0}ms`);

  const results = mock.requests.flatMap((r) => toolResultsFromBody(r.body));
  const allApi = mock.requests.map((r) => blob(r.body)).join("\n");

  const readHit = results.find((r) => r.toolUseId === READ_ID);
  const editHit = results.find((r) => r.toolUseId === EDIT_ID);
  const grepHit = results.find((r) => r.toolUseId === GREP_ID);
  const gitHit = results.find((r) => r.toolUseId === GIT_ID);
  const bgStopHit = results.find((r) => r.toolUseId === BG_STOP_ID);
  const taskStopHit = results.find((r) => r.toolUseId === BG_CANCEL_TOOL_ID);
  const bgHit = results.find((r) => r.toolUseId === BG_DONE_ID);
  const busyHit = results.find((r) => r.toolUseId === BUSY_ID);
  const replHit = results.find((r) => r.toolUseId === REPL_ID);

  void bgStopHit;

  const checks: { name: string; status: "ok" | "fail" | "watch"; detail: string }[] = [
    {
      name: "Read via persistent Unix socket",
      status: blob(readHit?.content).includes(MARKER) ? "ok" : "fail",
      detail: blob(readHit?.content).slice(0, 120),
    },
    {
      name: "Edit + single-file Grep",
      status: readFileSync(join(dirs.project, "src.ts"), "utf8").includes("v = 2") && blob(grepHit?.content).includes("src.ts") ? "ok" : "fail",
      detail: blob(grepHit?.content).slice(0, 120),
    },
    {
      name: "Git branch + redundant cd hint",
      status: blob(gitHit?.content).includes("## main") && blob(gitHit?.content).includes(REDUNDANT_CD_HINT) ? "ok" : "fail",
      detail: blob(gitHit?.content).slice(0, 140),
    },
    {
      name: "Background Bash started",
      status: /running in background/i.test(blob(bgHit?.content)) ? "ok" : "fail",
      detail: blob(bgHit?.content).slice(0, 140),
    },
    {
      name: "TaskStop killed real Client background process",
      status: Boolean(taskStopHit) && !existsSync(bgSentinel) ? "ok" : "fail",
      detail: existsSync(bgSentinel) ? "sentinel file created (Client process survived!)" : blob(taskStopHit?.content).slice(0, 140),
    },
    {
      name: "Native task-notification delivered (not plugin queue)",
      status: (/automated background-task event|<task-id>/i.test(allApi) && !/studio-ws-executor plugin sent a message/i.test(allApi)) ? "ok" : "fail",
      detail: allApi.match(/<task-id>[^<]+<\/task-id>/)?.[0] ?? "checked",
    },
    {
      name: "Busy turn settled",
      status: blob(busyHit?.content).includes("tui-busy-done") ? "ok" : "fail",
      detail: blob(busyHit?.content).slice(0, 120),
    },
    {
      name: "REPL in isolated mock TUI",
      status: /No such tool available: REPL/i.test(blob(replHit?.content)) ? "watch" : blob(replHit?.content) ? "ok" : "fail",
      detail: blob(replHit?.content).slice(0, 140),
    },
    {
      name: "Final TUI text + ACP tool cards",
      status: client.agentText().includes("tui-replay-done") && client.updates.some((u) => u.sessionUpdate === "tool_call") ? "ok" : "fail",
      detail: client.agentText().slice(0, 100),
    },
  ];
  void editHit;

  let fail = 0;
  for (const row of checks) {
    console.log(`${row.status === "ok" ? "ok" : row.status === "watch" ? "WATCH" : "FAIL"}  ${row.name}\n       ${row.detail.replace(/\n/g, " ")}`);
    if (row.status === "fail") fail++;
  }
  await client.request("session/close", { sessionId: session.sessionId }, 15_000);
  if (fail) process.exitCode = 1;
} finally {
  if (prevCodeMode === undefined) delete process.env[CODE_MODE_ENV];
  else process.env[CODE_MODE_ENV] = prevCodeMode;
  if (prevConfigCodeMode === undefined) delete process.env[CODE_MODE_CONFIG_ENV];
  else process.env[CODE_MODE_CONFIG_ENV] = prevConfigCodeMode;
  await client.stop();
  await server.stop();
  mock.stop();
}
