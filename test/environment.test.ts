import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withPlugin } from "../src/compose.js";
import { sessionSyncPaths } from "../src/launch.js";
import { debugOn, summarize } from "../src/debug.js";
import { buildSanitizedEnv, buildSpawnArgv, extraClaudeFlags, parseCcModsRelayMeta } from "../src/engine-pty.js";
import { remoteEnvPrefix } from "../src/ssh.js";
import { TEST_API_KEY, isolatedWorkspace, pinMockSettings, testApiKeySuffix } from "./harness.js";
import {
  buildEnvironmentAppend,
  ENVIRONMENT_FILE,
  EXTRA_DIRS_FILE,
  extraDirsLine,
  resolveTuiCwd,
  trustTuiCwd,
  workspaceOnClient,
  writeSessionMount,
} from "../src/environment.js";
import { mapPath } from "../src/exec.js";
import { isLocalToolForwardEnabled } from "../src/local-tool-forward.js";
import { assertMockBaseUrl } from "../src/mock-anthropic.js";

test("environment append names the Mac cwd and inlines AGENTS.md and CLAUDE.md", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-env-"));
  writeFileSync(join(dir, "CLAUDE.md"), "use bun");
  writeFileSync(join(dir, "AGENTS.md"), "prefer AGENTS.md");
  const text = await buildEnvironmentAppend(dir);
  expect(text).toContain("# Environment");
  expect(text).toContain(`Working directory: ${dir}`);
  expect(text).toContain("File and shell tools");
  expect(text).toContain("Contents of " + join(dir, "CLAUDE.md"));
  expect(text).toContain("Contents of " + join(dir, "AGENTS.md"));
  expect(text).toContain("use bun");
  expect(text).toContain("prefer AGENTS.md");
  expect(text).toContain("Is a git repository: no");
});

test("session sync includes AGENTS.md even when .claude is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-sync-"));
  writeFileSync(join(dir, "AGENTS.md"), "# agents\n");
  expect(sessionSyncPaths(dir)).toEqual(["AGENTS.md"]);
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, "CLAUDE.md"), "use bun\n");
  expect(sessionSyncPaths(dir)).toEqual([".claude", "AGENTS.md", "CLAUDE.md"]);
});

test("environment append includes git snapshot when the cwd is a repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-git-"));
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir });
  git(["init"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(["add", "a.txt"]);
  git(["commit", "-m", "init"]);
  const text = await buildEnvironmentAppend(dir);
  expect(text).toContain("Is a git repository: yes");
  expect(text).toContain("# gitStatus");
  expect(text).toContain("init");
});

test("withPlugin adds append-system-prompt-file when the plugin ships environment.txt", () => {
  const plugin = mkdtempSync(join(tmpdir(), "cc-mods-plug-"));
  writeFileSync(join(plugin, ENVIRONMENT_FILE), "Working directory: /Users/me/proj\n");
  const cmd = withPlugin("claude --session-id sess", plugin);
  expect(cmd).toContain(`--plugin-dir '${plugin}'`);
  expect(cmd).toContain(`--append-system-prompt-file '${plugin}/${ENVIRONMENT_FILE}'`);
});

test("Mac absolute paths already under cwd pass through mapPath", () => {
  const cwd = "/Users/me/proj";
  const tui = "/Users/ray/Workspace/abc";
  expect(mapPath(cwd, tui, "/Users/me/proj/src/a.ts")).toBe("/Users/me/proj/src/a.ts");
});

test("remote TUI cwd stays on Mini; extra dirs are named in the environment append", () => {
  expect(workspaceOnClient({ fs: { readTextFile: true, writeTextFile: true } })).toBe(true);
  expect(workspaceOnClient({ environmentFile: true })).toBe(true);
  expect(workspaceOnClient({ fs: {} })).toBe(false);
  expect(resolveTuiCwd("/Users/me/proj", true, "/tmp/tui")).toBe("/tmp/tui");
  expect(resolveTuiCwd("/Users/me/proj", false, "/tmp/tui")).toBe("/Users/me/proj");
  expect(extraDirsLine(["/Users/me/other"])).toContain("/Users/me/other");
});

test("trustTuiCwd marks the host session cwd trusted without rewriting other projects", () => {
  const home = mkdtempSync(join(tmpdir(), "cc-mods-trust-"));
  const config = join(home, ".claude.json");
  writeFileSync(config, JSON.stringify({ projects: { "/old": { hasTrustDialogAccepted: true } } }));
  trustTuiCwd("/tmp/tui-placeholder", {}, home);
  const json = JSON.parse(readFileSync(config, "utf8")) as {
    projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
  };
  expect(json.projects["/old"]).toEqual({ hasTrustDialogAccepted: true });
  expect(json.projects["/tmp/tui-placeholder"]).toEqual({ hasTrustDialogAccepted: true });
});

test("session mount writes extra dirs next to the plugin without process.env", async () => {
  const plugin = mkdtempSync(join(tmpdir(), "cc-mods-mount-"));
  writeFileSync(join(plugin, ENVIRONMENT_FILE), "Working directory: /Users/me/proj\n");
  await writeSessionMount(plugin, "/Users/me/proj", ["/Users/me/other"]);
  expect(JSON.parse(readFileSync(join(plugin, EXTRA_DIRS_FILE), "utf8"))).toEqual(["/Users/me/other"]);
  expect(readFileSync(join(plugin, ENVIRONMENT_FILE), "utf8")).toContain("/Users/me/other");
  expect(readFileSync(join(plugin, ENVIRONMENT_FILE), "utf8")).toContain("Working directory: /Users/me/proj");
});

test("isolated TUI config pre-approves the mock API key under CLAUDE_CONFIG_DIR", () => {
  const dirs = isolatedWorkspace();
  pinMockSettings(dirs.config, "http://127.0.0.1:9");
  const global = JSON.parse(readFileSync(join(dirs.config, ".claude.json"), "utf8")) as {
    customApiKeyResponses: { approved: string[] };
  };
  const settings = JSON.parse(readFileSync(join(dirs.config, "settings.json"), "utf8")) as {
    env: { ANTHROPIC_BASE_URL: string; ANTHROPIC_API_KEY: string };
  };
  expect(global.customApiKeyResponses.approved).toEqual([testApiKeySuffix()]);
  expect(settings.env).toEqual({ ANTHROPIC_BASE_URL: "http://127.0.0.1:9", ANTHROPIC_API_KEY: TEST_API_KEY });
});

test("remote env prefix is env(1) assignments so zsh ssh -c can apply them", () => {
  const prefix = remoteEnvPrefix({
    CC_MODS_MOCK: "1",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
    ANTHROPIC_API_KEY: "sk-ant-test-cc-mods-relay",
    ANTHROPIC_MODEL: "haiku",
    CC_MODS_DEBUG: "1",
  });
  expect(prefix).toContain("ANTHROPIC_BASE_URL='http://127.0.0.1:9'");
  expect(prefix).toContain("ANTHROPIC_API_KEY='sk-ant-test-cc-mods-relay'");
  expect(prefix).toContain("ANTHROPIC_MODEL='haiku'");
  expect(prefix).toContain("CC_MODS_DEBUG='1'");
  expect(prefix.endsWith(" ")).toBe(true);
});

test("mock guard refuses a real Anthropic base URL", () => {
  expect(() => assertMockBaseUrl({ CC_MODS_MOCK: "1", ANTHROPIC_BASE_URL: "https://api.anthropic.com" })).toThrow(/127\.0\.0\.1/);
  expect(() => assertMockBaseUrl({ CC_MODS_MOCK: "1", ANTHROPIC_BASE_URL: "http://127.0.0.1:9" })).not.toThrow();
  expect(() => assertMockBaseUrl({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" })).not.toThrow();
});

test("extra Claude flags come from initialize._meta.ccModsRelay", () => {
  expect(extraClaudeFlags({})).toBe("");
  expect(parseCcModsRelayMeta({ ccModsRelay: { noChrome: true, skipPermissions: true, tools: ["Read", "Write"] } })).toEqual({
    noChrome: true,
    skipPermissions: true,
    tools: ["Read", "Write"],
  });
  expect(extraClaudeFlags({ noChrome: true, skipPermissions: true, tools: ["Read", "Write"] })).toBe(
    " --no-chrome --dangerously-skip-permissions --tools Read,Write",
  );
  expect(extraClaudeFlags({ model: "haiku" })).toBe(" --model haiku");
});

test("debug tracing is off unless CC_MODS_DEBUG is set", () => {
  expect(debugOn({})).toBe(false);
  expect(debugOn({ CC_MODS_DEBUG: "1" })).toBe(true);
  expect(summarize({ file: { base64: "x".repeat(40) } })).toContain("<40 chars>");
});

test("TUI spawn env looks like a user session and drops billing plus relay internals", () => {
  const env = buildSanitizedEnv({
    PATH: "/bin",
    HOME: "/tmp/iso",
    USER: "kee",
    LANG: "en_US.UTF-8",
    EDITOR: "vim",
    XDG_CONFIG_HOME: "/tmp/iso/.config",
    SSH_AUTH_SOCK: "/tmp/ssh.sock",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
    ANTHROPIC_API_KEY: "sk-ant-test",
    CLAUDECODE: "1",
    CC_MODS_SOCKET: "/tmp/mod.sock",
    CC_MODS_PLUGIN_DIR: "/tmp/plugin",
    FORK_GATE: "on",
    CLAUDE_TUI_BACKEND: "herdr",
  });
  expect(env.PATH).toBe("/bin");
  expect(env.USER).toBe("kee");
  expect(env.EDITOR).toBe("vim");
  expect(env.XDG_CONFIG_HOME).toBe("/tmp/iso/.config");
  expect(env.SSH_AUTH_SOCK).toBe("/tmp/ssh.sock");
  expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9");
  expect(env.TERM).toBe("xterm-256color");
  expect(env.CC_MODS_SOCKET).toBe("/tmp/mod.sock");
  expect(env.CLAUDECODE).toBeUndefined();
  expect(env.CC_MODS_PLUGIN_DIR).toBeUndefined();
  expect(env.FORK_GATE).toBeUndefined();
  expect(env.CLAUDE_TUI_BACKEND).toBeUndefined();
  expect(buildSpawnArgv("sess")[0]).toBe("-c");
});

test("local-tool-forward stays off so it cannot race Mods intercept", () => {
  expect(isLocalToolForwardEnabled({ CLAUDE_TUI_LOCAL_TOOL_FORWARD: "1" })).toBe(false);
});
