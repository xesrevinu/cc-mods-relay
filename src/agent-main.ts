import { existsSync } from "node:fs";
import { join } from "node:path";
import { runAcp, driveFastModeProbe } from "./acp-agent.js";
import { stackedEngine } from "./compose.js";
import { ENVIRONMENT_FILE } from "./environment.js";
import { applyManagedPolicyEnv } from "./managed-policy.js";
import { assertMockBaseUrl } from "./mock-anthropic.js";
import { usageUpdateEnabled } from "./usage-env.js";
import { liveDiffEnabled } from "./live-diff-env.js";
import { liveSubagentWatchEnabled } from "./live-subagent-env.js";
import { bindModChannel, startModChannel } from "./mod-channel.js";
import { resolveTerminalBackendName } from "./terminal-backend.js";
import { installTuiExitHooks, reapAllTuis } from "./tui-lifetime.js";
import { reapOrphanHerdrWorkspaces, reapOrphanPluginProcesses } from "./tui-reap.js";

export async function ensureHerdr(session: string) {
  if (resolveTerminalBackendName() === "bun-pty") return;
  if (process.env.HERDR_ENV === "1") return;
  const probe = Bun.spawn(["herdr", "--session", session, "workspace", "list"], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  if ((await probe.exited) === 0) return;
  const server = Bun.spawn(["herdr", "--session", session, "server"], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  server.unref();
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(100);
    const again = Bun.spawn(["herdr", "--session", session, "workspace", "list"], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    if ((await again.exited) === 0) return;
  }
  console.error(`cc-mods-relay: herdr session ${session} did not start; falling back to bun PTY`);
  process.env.CLAUDE_TUI_BACKEND = "pty";
}

export async function runAgent(pluginDir: string) {
  assertMockBaseUrl();
  process.env.CLAUDE_TUI_BACKEND ??= "herdr";
  process.env.CLAUDE_TUI_MODEL_CATALOG ??= "builtin";
  process.env.CC_MODS_PLUGIN_DIR = pluginDir;
  if (existsSync(join(pluginDir, ENVIRONMENT_FILE))) {
    process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS ??= "1";
  }
  const herdrSession = process.env.HERDR_ENV === "1"
    ? process.env.HERDR_SESSION || process.env.CLAUDE_TUI_HERDR_SESSION || "default"
    : "cc-mods-relay";
  process.env.CLAUDE_TUI_HERDR_SESSION = herdrSession;
  const channel = startModChannel();
  bindModChannel(channel);
  process.env.CC_MODS_SOCKET = channel.path;
  installTuiExitHooks();
  await ensureHerdr(herdrSession);
  if (resolveTerminalBackendName() !== "bun-pty") {
    reapOrphanHerdrWorkspaces({ herdrSession });
  }
  reapOrphanPluginProcesses(pluginDir);
  const startEngine = await stackedEngine(pluginDir, herdrSession);

  await applyManagedPolicyEnv();
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  console.debug = console.error;

  const { connection, agent } = runAcp({
    startEngine,
    usageUpdate: usageUpdateEnabled(),
    gate: process.env.FORK_GATE === "on",
    liveDiff: liveDiffEnabled(),
    liveSubagentWatch: liveSubagentWatchEnabled(),
    fastModeProbe: process.env.FAST_MODE_FORCE === "1" ? () => true : process.env.FAST_MODE_LIVE === "1" ? driveFastModeProbe : undefined,
  });

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    await agent.dispose().catch((error) => console.error(error));
    await Bun.sleep(400);
    reapAllTuis();
    channel.stop();
    process.exit(0);
  }
  connection.closed.then(shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // sshd sends SIGHUP when the ACP tunnel drops. Without a handler, Bun
  // exits before dispose/reapers run and herdr panes leak (PPID=1).
  if (process.platform !== "win32") process.on("SIGHUP", shutdown);
  process.stdin.resume();
}
