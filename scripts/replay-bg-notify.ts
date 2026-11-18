/**
 * Replay the live background-notify failure against a real local Claude Code
 * pointed at the mock API. Does not rerun the original ios-sim / ci.sh work.
 *
 * The live JSONL shape did:
 *   REPL $`nohup bash -c '… ci.sh …' &`
 *   inner Bash callIds repl_*
 *   queue-operation enqueue of <task-notification>
 *   later a user turn origin.kind=plugin ("The studio-ws-executor plugin sent a message")
 *
 * This run uses the same shape: Code Mode REPL + a detaching nohup, then a
 * sleep that keeps the turn busy so a completion can land in the queue.
 *
 *   CC_MODS_LIVE_SESSION=<uuid> bun scripts/replay-bg-notify.ts
 */
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startMockAnthropic, type ScriptedTurn } from "../src/mock-anthropic.js";
import { startRelay } from "../src/relay.js";
import { stagePlugin } from "../src/launch.js";
import { acceptCodeModeCaveats } from "../src/environment.js";
import { CODE_MODE_ENV } from "../src/config.js";
import {
  claudeBin,
  claudeEnv,
  isolatedWorkspace,
  runPrintClaude,
} from "../test/harness.js";

const LIVE_SESSION = process.env.CC_MODS_LIVE_SESSION || "";
const REPL_ID = "toolu_01ReplayReplNotify000000";
const WAIT_ID = "toolu_01ReplayWaitBusy0000000";

function toolId(name: string): string {
  return `toolu_01${name.replace(/[^A-Za-z]/g, "").padEnd(20, "X").slice(0, 20)}000000`;
}

function liveTranscript(): string | undefined {
  if (!LIVE_SESSION) return undefined;
  const root = join(homedir(), ".claude", "projects");
  const hits = globSync(join(root, "**", `${LIVE_SESSION}.jsonl`));
  return hits[0];
}

function summarizeLive(path: string): void {
  let pluginTurns = 0;
  let enqueued = 0;
  const ids = new Set<string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (row.type === "queue-operation" && row.operation === "enqueue") {
      const content = String(row.content ?? "");
      if (content.includes("<task-notification>")) {
        enqueued++;
        const id = content.match(/<tool-use-id>([^<]+)</)?.[1];
        if (id) ids.add(id);
      }
    }
    const origin = row.origin as { kind?: string; name?: string } | undefined;
    if (origin?.kind === "plugin") pluginTurns++;
  }
  console.log("live jsonl");
  console.log(`  enqueued task-notification: ${enqueued}`);
  console.log(`  plugin-origin turns: ${pluginTurns}`);
  console.log(`  ids: ${[...ids].slice(-4).join(", ")}`);
  console.log("  origin was plugin, not task-notification (Waiting to be delivered)");
}

function scanReplay(configDir: string): {
  pluginTurns: number;
  taskTurns: number;
  enqueued: number;
  waiterFiles: string[];
} {
  const jsonl = globSync(join(configDir, "projects", "**", "*.jsonl"));
  let pluginTurns = 0;
  let taskTurns = 0;
  let enqueued = 0;
  for (const file of jsonl) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const origin = row.origin as { kind?: string } | undefined;
      if (origin?.kind === "plugin") pluginTurns++;
      if (origin?.kind === "task-notification") taskTurns++;
      const text =
        typeof (row.message as { content?: unknown } | undefined)?.content === "string"
          ? String((row.message as { content: string }).content)
          : String(row.content ?? "");
      if (row.type === "queue-operation" && row.operation === "enqueue" && text.includes("<task-notification>")) {
        enqueued++;
      }
      if (text.includes("The studio-ws-executor plugin sent a message")) pluginTurns++;
      if (text.includes("<task-notification>") && origin?.kind === "task-notification") taskTurns++;
    }
  }
  const waiterFiles = globSync("/tmp/cc-mods-wait/toolu_01Replay*");
  return { pluginTurns, taskTurns, enqueued, waiterFiles };
}

const turns: ScriptedTurn[] = [
  {
    blocks: [
      {
        type: "tool_use",
        id: REPL_ID,
        name: "REPL",
        input: {
          description: "Rerun CI after renames",
          code: [
            "await $`nohup bash -c 'sleep 3; echo sim-ci-done >/tmp/cc-mods-sim-ci.log; echo EXIT=0 >>/tmp/cc-mods-sim-ci.log' >/dev/null 2>&1 &`.nothrow();",
            "await $`sleep 6; echo still-in-turn`.nothrow();",
          ].join("\n"),
        },
      },
    ],
  },
  {
    blocks: [
      {
        type: "tool_use",
        id: toolId("BashBg"),
        name: "Bash",
        input: {
          command: "sleep 3; printf 'sim-ci-done\\n'",
          run_in_background: true,
        },
      },
    ],
  },
  {
    blocks: [
      {
        type: "tool_use",
        id: WAIT_ID,
        name: "Bash",
        input: { command: "sleep 6; printf 'still-in-turn\\n'" },
      },
    ],
  },
  { blocks: [{ type: "text", text: "replay-done" }] },
];

const bin = claudeBin();
if (!bin) {
  console.error("claude is not on PATH");
  process.exit(1);
}

const live = liveTranscript();
if (live) summarizeLive(live);
else if (LIVE_SESSION) console.log("live jsonl not found");

const dirs = isolatedWorkspace();
const cfgPath = join(dirs.config, ".claude.json");
const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
cfg.codeModeCaveatsAcceptedV1 = true;
cfg.codeModeAutoModeCaveatAcceptedV1 = true;
writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
acceptCodeModeCaveats({ CLAUDE_CONFIG_DIR: dirs.config }, dirs.root);

const mock = startMockAnthropic(turns);
const relay = startRelay();
relay.bind("replay", dirs.project, dirs.tui);
const calls: { tool?: string; callId?: string }[] = [];
relay.onTool((frame) => {
  calls.push({ tool: frame.tool, callId: frame.callId });
  console.log("relay call", frame.tool, frame.callId);
});
const pluginDir = await stagePlugin({
  url: relay.url,
  token: relay.token,
  cwd: dirs.project,
  tuiRoot: dirs.tui,
});

console.log("mock", mock.url);
console.log("plugin", pluginDir);

try {
  const ran = await runPrintClaude({
    bin,
    cwd: dirs.tui,
    pluginDir,
    env: claudeEnv({
      mockUrl: mock.url,
      configDir: dirs.config,
      extra: {
        [CODE_MODE_ENV]: "1",
        CC_MODS_CODE_MODE: "1",
      },
    }),
    extraArgs: ["--allowedTools", "Grep,Glob,REPL"],
    prompt: "Replay the background CI notify.",
    timeoutMs: 90_000,
  });
  console.log("claude exit", ran.code);
  console.log("stdout tail\n", ran.stdout.slice(-2500));
  if (ran.code !== 0) console.log("stderr tail\n", ran.stderr.slice(-2500));
  const seen = scanReplay(dirs.config);
  console.log("replay jsonl", seen);
  console.log("relay tools", calls);
  console.log("mock remaining", mock.remaining());
  if (seen.taskTurns > 0 && seen.pluginTurns === 0) {
    console.log("observed: native task-notification (waiter path)");
  } else if (seen.pluginTurns > 0 || seen.enqueued > 0) {
    console.log("observed: plugin queue (Waiting to be delivered)");
  } else {
    console.log("observed: no notify in jsonl — check relay/waiter files", seen.waiterFiles);
  }
} finally {
  mock.stop();
  relay.stop();
}
