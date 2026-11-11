import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "bun";

export const MARKER = "workspace-secret-42";

/** Isolated Claude Code never sees a real Anthropic credential. */
export const TEST_API_KEY = "sk-ant-test-cc-mods-relay";

/** Claude stores custom-key approval as the last 20 characters of the key. */
export function testApiKeySuffix(key = TEST_API_KEY): string {
  return key.trim().slice(-20);
}

export function claudeBin(): string | null {
  return which("claude") ?? null;
}

function isolatedClaudeJson(projects: string[]) {
  const trusted: Record<string, { hasTrustDialogAccepted: true }> = {};
  for (const dir of projects) trusted[dir] = { hasTrustDialogAccepted: true };
  return {
    hasCompletedOnboarding: true,
    theme: "dark",
    opusProMigrationComplete: true,
    sonnet1m45MigrationComplete: true,
    firstStartTime: "2026-01-01T00:00:00.000Z",
    bypassPermissionsModeAccepted: true,
    customApiKeyResponses: { approved: [testApiKeySuffix()], rejected: [] as string[] },
    projects: trusted,
  };
}

export function isolatedWorkspace() {
  let root = mkdtempSync(join(tmpdir(), "cc-mods-iso-"));
  let project = join(root, "project");
  let tui = join(root, "tui");
  let config = join(root, "claude-config");
  mkdirSync(project);
  mkdirSync(tui);
  mkdirSync(config);
  project = realpathSync(project);
  tui = realpathSync(tui);
  config = realpathSync(config);
  root = realpathSync(root);
  writeFileSync(join(project, "hello.txt"), `${MARKER}\n`);
  writeFileSync(join(project, "AGENTS.md"), "# agents\n");
  writeFileSync(join(project, "CLAUDE.md"), "use bun\n");
  writeFileSync(
    join(project, "note.ipynb"),
    JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ id: "c1", cell_type: "code", source: ["print(1)\n"], metadata: {}, outputs: [], execution_count: null }],
    }),
  );
  const globalConfig = JSON.stringify(isolatedClaudeJson([tui, project]), null, 2);
  // CLAUDE_CONFIG_DIR/.claude.json is what Claude 2.1 reads when CONFIG_DIR is set.
  // HOME/.claude.json is the fallback if a spawn ignores CONFIG_DIR.
  writeFileSync(join(config, ".claude.json"), globalConfig);
  writeFileSync(join(root, ".claude.json"), globalConfig);
  writeFileSync(join(config, "settings.json"), JSON.stringify({ autoUpdates: false, theme: "dark" }, null, 2));
  return { root, project, tui, config };
}

export function pinMockSettings(configDir: string, mockUrl: string): void {
  writeFileSync(
    join(configDir, "settings.json"),
    JSON.stringify(
      {
        autoUpdates: false,
        theme: "dark",
        env: {
          ANTHROPIC_BASE_URL: mockUrl,
          ANTHROPIC_API_KEY: TEST_API_KEY,
        },
      },
      null,
      2,
    ),
  );
}

export function claudeEnv(opts: { mockUrl: string; configDir: string; extra?: Record<string, string> }): Record<string, string> {
  pinMockSettings(opts.configDir, opts.mockUrl);
  return {
    ...process.env,
    ...opts.extra,
    ANTHROPIC_API_KEY: TEST_API_KEY,
    ANTHROPIC_BASE_URL: opts.mockUrl,
    CLAUDE_CONFIG_DIR: opts.configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTOUPDATER: "1",
    CC_MODS_MOCK: "1",
    CI: "1",
    TERM: "dumb",
    NO_COLOR: "1",
  };
}

export function tuiInitializeParams(tools: string[] = ["Read"]) {
  return {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    _meta: { ccModsRelay: { noChrome: true, skipPermissions: true, tools } },
  };
}

export function tuiEnv(opts: { mockUrl: string; configDir: string; extra?: Record<string, string> }): Record<string, string> {
  const home = opts.extra?.HOME;
  const env = {
    ...claudeEnv(opts),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    FORK_GATE: "off",
    ...(home ? { HOME: home } : {}),
    ...opts.extra,
  };
  // --bare / SIMPLE skips plugin hooks, so Mods never intercepts.
  delete env.CLAUDE_CODE_SIMPLE;
  return env;
}

export async function runPrintClaude(opts: {
  bin: string;
  cwd: string;
  pluginDir: string;
  env: Record<string, string>;
  prompt: string;
  timeoutMs?: number;
  extraArgs?: string[];
}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(
    [
      opts.bin,
      "--plugin-dir",
      opts.pluginDir,
      "--print",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
      "--no-chrome",
      "--model",
      "claude-opus-4-6",
      ...(opts.extraArgs ?? []),
    ],
    {
      cwd: opts.cwd,
      env: opts.env,
      stdin: new Blob([opts.prompt]).stream(),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const timed = Bun.sleep(timeoutMs).then(() => {
    proc.kill();
    return "timeout" as const;
  });
  const finished = proc.exited.then(() => "ok" as const);
  const outcome = await Promise.race([timed, finished]);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (outcome === "timeout") {
    return { code: 124, stdout, stderr: stderr + "\ncc-mods-relay: claude -p timed out" };
  }
  return { code: proc.exitCode ?? 1, stdout, stderr };
}
