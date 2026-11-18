import { runAcp, driveFastModeProbe, type AgentDeps } from "./acp-agent.js";
import { stackedEngine } from "./compose.js";
import { applyManagedPolicyEnv } from "./managed-policy.js";
import { assertMockBaseUrl } from "./mock-anthropic.js";
import { usageUpdateEnabled } from "./usage-env.js";
import { liveDiffEnabled } from "./live-diff-env.js";
import { liveSubagentWatchEnabled } from "./live-subagent-env.js";
import { bindModChannel, startModChannel } from "./mod-channel.js";
import { codeModeEnabled } from "./config.js";
import { CODE_MODE_SETTLE_MS } from "./end-of-turn.js";
import { resolveTerminalBackendName } from "./terminal-backend.js";
import { installTuiExitHooks, reapAllTuis } from "./tui-lifetime.js";
import { reapOrphanHerdrWorkspaces, reapOrphanPluginProcesses } from "./tui-reap.js";
import { DEFAULT_HERDR_SESSION } from "./herdr-names.js";

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

export type BootedAgent = {
  pluginDir: string;
  clientCwd?: string;
  channel: ReturnType<typeof startModChannel>;
  herdrSession: string;
  deps: AgentDeps;
};

export async function bootAgent(
  pluginDir: string,
  opts: { cwd?: string; tuiRoot?: string; env?: NodeJS.ProcessEnv; bindProcess?: boolean } = {},
): Promise<BootedAgent> {
  const env = opts.env ?? process.env;
  assertMockBaseUrl(env);
  process.env.CLAUDE_TUI_BACKEND ??= env.CLAUDE_TUI_BACKEND ?? "herdr";
  process.env.CLAUDE_TUI_MODEL_CATALOG ??= "builtin";
  const herdrSession = env.HERDR_ENV === "1"
    ? env.HERDR_SESSION || env.CLAUDE_TUI_HERDR_SESSION || "default"
    : env.CLAUDE_TUI_HERDR_SESSION?.trim() || process.env.CLAUDE_TUI_HERDR_SESSION?.trim() || DEFAULT_HERDR_SESSION;
  process.env.CLAUDE_TUI_HERDR_SESSION = herdrSession;
  const channel = startModChannel();
  if (opts.bindProcess !== false) {
    bindModChannel(channel);
    process.env.CC_MODS_PLUGIN_DIR = pluginDir;
    process.env.CC_MODS_SOCKET = channel.path;
  }
  installTuiExitHooks();
  await ensureHerdr(herdrSession);
  if (resolveTerminalBackendName() !== "bun-pty") {
    reapOrphanHerdrWorkspaces({ herdrSession });
  }
  reapOrphanPluginProcesses(pluginDir);
  const inner = await stackedEngine(pluginDir, herdrSession);
  await applyManagedPolicyEnv();
  const startEngine: AgentDeps["startEngine"] = (args) =>
    inner({
      ...args,
      baseEnv: {
        ...process.env,
        ...env,
        ...(args.baseEnv ?? {}),
        CC_MODS_SOCKET: channel.path,
      },
    });
  return {
    pluginDir,
    clientCwd: opts.cwd,
    channel,
    herdrSession,
    deps: {
      startEngine,
      usageUpdate: usageUpdateEnabled(),
      gate: (env.FORK_GATE ?? process.env.FORK_GATE) === "on",
      liveDiff: liveDiffEnabled(),
      liveSubagentWatch: liveSubagentWatchEnabled(),
      fastModeProbe: env.FAST_MODE_FORCE === "1" || process.env.FAST_MODE_FORCE === "1"
        ? () => true
        : env.FAST_MODE_LIVE === "1" || process.env.FAST_MODE_LIVE === "1"
          ? driveFastModeProbe
          : undefined,
      clientCwd: opts.cwd,
      tuiRoot: opts.tuiRoot,
      pluginDir,
      modChannel: channel,
      turnSettleMs: codeModeEnabled(env) ? CODE_MODE_SETTLE_MS : 0,
    },
  };
}

export async function runAgent(
  pluginDir: string,
  opts: { cwd?: string; stream?: Parameters<typeof runAcp>[0] } = {},
) {
  const boot = await bootAgent(pluginDir, { cwd: opts.cwd });
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  console.debug = console.error;

  const { connection, agent } = runAcp(opts.stream, boot.deps);

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    await agent.dispose().catch((error) => console.error(error));
    await Bun.sleep(400);
    reapAllTuis();
    boot.channel.stop();
    process.exit(0);
  }
  connection.closed.then(shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  if (process.platform !== "win32") process.on("SIGHUP", shutdown);
  process.stdin.resume();
  await connection.closed;
}
