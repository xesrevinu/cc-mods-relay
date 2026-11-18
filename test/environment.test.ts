import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withPlugin } from "../src/compose.js";
import {
  collectHomeFiles,
  collectSessionFiles,
  hashSyncFiles,
  homeSyncPaths,
  rememberSessionSync,
  selectSyncFiles,
  sessionSyncPaths,
  writeHomeFiles,
} from "../src/launch.js";
import { debugOn, summarize } from "../src/debug.js";
import { collectForwardedEnv } from "../src/forwarded-env.js";
import { buildSanitizedEnv, buildSpawnArgv, extraClaudeFlags, parseCcModsRelayMeta } from "../src/engine-pty.js";
import { CODE_MODE_CONFIG_ENV, CODE_MODE_ENV, resetConfigForTests } from "../src/config.js";
import { remoteEnvPrefix } from "../src/ssh.js";
import { TEST_API_KEY, isolatedWorkspace, pinMockSettings, testApiKeySuffix } from "./harness.js";
import {
  acceptCodeModeCaveats,
  CODE_MODE_CAVEAT_KEYS,
  EXTRA_DIRS_FILE,
  resolveTuiCwd,
  sessionClientCwd,
  trustTuiCwd,
  workspaceOnClient,
  writeSessionMount,
} from "../src/environment.js";
import { mapPath } from "../src/exec.js";
import { isLocalToolForwardEnabled } from "../src/local-tool-forward.js";
import { assertMockBaseUrl } from "../src/mock-anthropic.js";

test("session sync includes AGENTS.md even when .claude is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-sync-"));
  writeFileSync(join(dir, "AGENTS.md"), "# agents\n");
  expect(sessionSyncPaths(dir)).toEqual(["AGENTS.md"]);
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, "CLAUDE.md"), "use bun\n");
  expect(sessionSyncPaths(dir)).toEqual([".claude", "AGENTS.md", "CLAUDE.md"]);
});

test("session sync includes .agents and .claude/.agents", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-sync-agents-"));
  mkdirSync(join(dir, ".agents", "skills", "demo"), { recursive: true });
  writeFileSync(join(dir, ".agents", "skills", "demo", "SKILL.md"), "# skill\n");
  expect(sessionSyncPaths(dir)).toEqual([".agents"]);
  mkdirSync(join(dir, ".claude", ".agents"), { recursive: true });
  writeFileSync(join(dir, ".claude", ".agents", "foo.md"), "# agent\n");
  expect(sessionSyncPaths(dir)).toEqual([".claude", ".agents"]);
  expect(collectSessionFiles(dir).map((file) => file.path).sort()).toEqual([
    ".agents/skills/demo/SKILL.md",
    ".claude/.agents/foo.md",
  ]);
});

test("home sync copies user-level skills and agents, not transcripts", () => {
  const home = mkdtempSync(join(tmpdir(), "cc-mods-home-sync-"));
  mkdirSync(join(home, ".claude", "skills", "demo"), { recursive: true });
  mkdirSync(join(home, ".claude", "agents"), { recursive: true });
  mkdirSync(join(home, ".claude", ".agents"), { recursive: true });
  mkdirSync(join(home, ".claude", "projects", "x"), { recursive: true });
  mkdirSync(join(home, ".agents", "skills", "work"), { recursive: true });
  writeFileSync(join(home, ".claude", "skills", "demo", "SKILL.md"), "# skill\n");
  writeFileSync(join(home, ".claude", "agents", "review.md"), "# agent\n");
  writeFileSync(join(home, ".claude", ".agents", "nested.md"), "# nested\n");
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "# global\n");
  writeFileSync(join(home, ".claude", "projects", "x", "session.jsonl"), "{}\n");
  writeFileSync(join(home, ".claude.json"), '{"oauth":true}\n');
  writeFileSync(join(home, ".agents", "skills", "work", "SKILL.md"), "# work\n");
  expect(homeSyncPaths(home)).toEqual([
    ".claude/skills",
    ".claude/agents",
    ".claude/.agents",
    ".agents",
    ".claude/CLAUDE.md",
  ]);
  expect(collectHomeFiles(home).map((file) => file.path).sort()).toEqual([
    ".agents/skills/work/SKILL.md",
    ".claude/.agents/nested.md",
    ".claude/CLAUDE.md",
    ".claude/agents/review.md",
    ".claude/skills/demo/SKILL.md",
  ]);

  const dest = mkdtempSync(join(tmpdir(), "cc-mods-home-write-"));
  writeHomeFiles(dest, [
    ...collectHomeFiles(home),
    { path: ".claude/projects/x/session.jsonl", content: "nope\n" },
    { path: "../escape.md", content: "nope\n" },
    { path: ".claude.json", content: "nope\n" },
  ]);
  expect(readFileSync(join(dest, ".claude/skills/demo/SKILL.md"), "utf8")).toBe("# skill\n");
  expect(readFileSync(join(dest, ".agents/skills/work/SKILL.md"), "utf8")).toBe("# work\n");
  expect(existsSync(join(dest, ".claude/projects/x/session.jsonl"))).toBe(false);
  expect(existsSync(join(dest, ".claude.json"))).toBe(false);
  expect(existsSync(join(dest, "escape.md"))).toBe(false);
});

test("local sync hashes skip unchanged project and home payloads", () => {
  const config = mkdtempSync(join(tmpdir(), "cc-mods-sync-cache-"));
  const prev = Bun.env.CC_MODS_CONFIG_DIR;
  Bun.env.CC_MODS_CONFIG_DIR = config;
  try {
    const cwd = mkdtempSync(join(tmpdir(), "cc-mods-sync-proj-"));
    const home = mkdtempSync(join(tmpdir(), "cc-mods-sync-home-"));
    mkdirSync(join(cwd, ".agents", "skills", "demo"), { recursive: true });
    mkdirSync(join(home, ".agents", "skills", "work"), { recursive: true });
    writeFileSync(join(cwd, "AGENTS.md"), "# project\n");
    writeFileSync(join(cwd, ".agents", "skills", "demo", "SKILL.md"), "# demo\n");
    writeFileSync(join(home, ".agents", "skills", "work", "SKILL.md"), "# work\n");
    const files = collectSessionFiles(cwd);
    const homeFiles = collectHomeFiles(home);
    const url = "ws://127.0.0.1:18765/session";
    expect(hashSyncFiles(files)).toBe(hashSyncFiles([...files].reverse()));

    const first = selectSyncFiles(url, cwd, home, files, homeFiles);
    expect(first.files).toEqual(files);
    expect(first.homeFiles).toEqual(homeFiles);
    rememberSessionSync(url, cwd, home, first.projectHash, first.homeHash);

    const second = selectSyncFiles(url, cwd, home, files, homeFiles);
    expect(second.files).toBeUndefined();
    expect(second.homeFiles).toBeUndefined();
    expect(second.projectHash).toBe(first.projectHash);
    expect(second.homeHash).toBe(first.homeHash);

    writeFileSync(join(cwd, "AGENTS.md"), "# project changed\n");
    const filesChanged = collectSessionFiles(cwd);
    const third = selectSyncFiles(url, cwd, home, filesChanged, homeFiles);
    expect(third.files).toEqual(filesChanged);
    expect(third.homeFiles).toBeUndefined();
    expect(third.projectHash).not.toBe(first.projectHash);
    expect(third.homeHash).toBe(first.homeHash);
  } finally {
    if (prev == null) delete Bun.env.CC_MODS_CONFIG_DIR;
    else Bun.env.CC_MODS_CONFIG_DIR = prev;
  }
});

test("withPlugin only adds --plugin-dir", () => {
  const plugin = mkdtempSync(join(tmpdir(), "cc-mods-plug-"));
  writeFileSync(join(plugin, "environment.txt"), "Working directory: /tmp/proj\n");
  const cmd = withPlugin("claude --session-id sess", plugin);
  expect(cmd).toContain(`--plugin-dir '${plugin}'`);
  expect(cmd).not.toContain("--append-system-prompt-file");
});

test("Mac absolute paths already under cwd pass through mapPath", () => {
  const cwd = "/Users/me/proj";
  const tui = "/Users/bob/Workspace/abc";
  expect(mapPath(cwd, tui, "/Users/me/proj/src/a.ts")).toBe("/Users/me/proj/src/a.ts");
});

test("remote TUI cwd stays on Mini when the client path is missing here", () => {
  expect(workspaceOnClient({ fs: { readTextFile: true, writeTextFile: true } })).toBe(true);
  expect(workspaceOnClient({ fs: {} })).toBe(false);
  expect(resolveTuiCwd("/tmp/cc-mods-missing-proj", true, "/tmp/tui")).toBe("/tmp/tui");
  expect(resolveTuiCwd("/tmp/cc-mods-missing-proj", false, "/tmp/tui")).toBe("/tmp/cc-mods-missing-proj");
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-tui-"));
  expect(resolveTuiCwd(dir, true, "/tmp/tui")).toBe(dir);
});

test("acceptCodeModeCaveats writes the first-run flags without dropping other keys", () => {
  const home = mkdtempSync(join(tmpdir(), "cc-mods-code-mode-"));
  const config = join(home, ".claude.json");
  writeFileSync(config, JSON.stringify({ projects: { "/old": { hasTrustDialogAccepted: true } } }));
  chmodSync(config, 0o600);
  acceptCodeModeCaveats({}, home);
  const json = JSON.parse(readFileSync(config, "utf8")) as Record<string, unknown>;
  expect(json.projects).toEqual({ "/old": { hasTrustDialogAccepted: true } });
  for (const key of CODE_MODE_CAVEAT_KEYS) expect(json[key]).toBe(true);
  expect(statSync(config).mode & 0o777).toBe(0o600);
});

test("acceptCodeModeCaveats does not rewrite ~/ .claude.json when CLAUDE_CONFIG_DIR is set", () => {
  const home = mkdtempSync(join(tmpdir(), "cc-mods-code-mode-home-"));
  const isolated = mkdtempSync(join(tmpdir(), "cc-mods-code-mode-iso-"));
  const homeConfig = join(home, ".claude.json");
  writeFileSync(homeConfig, JSON.stringify({ oauth: "secret" }));
  acceptCodeModeCaveats({ CLAUDE_CONFIG_DIR: isolated }, home);
  expect(JSON.parse(readFileSync(homeConfig, "utf8"))).toEqual({ oauth: "secret" });
  const isolatedConfig = join(isolated, ".claude.json");
  const json = JSON.parse(readFileSync(isolatedConfig, "utf8")) as Record<string, unknown>;
  for (const key of CODE_MODE_CAVEAT_KEYS) expect(json[key]).toBe(true);
  expect(statSync(isolatedConfig).mode & 0o777).toBe(0o600);
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
  await writeSessionMount(plugin, ["/tmp/other"]);
  expect(JSON.parse(readFileSync(join(plugin, EXTRA_DIRS_FILE), "utf8"))).toEqual(["/tmp/other"]);
  expect(existsSync(join(plugin, "environment.txt"))).toBe(false);
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
  expect(extraClaudeFlags({})).toBe(" --allowedTools Grep,Glob");
  expect(parseCcModsRelayMeta({ ccModsRelay: { noChrome: true, skipPermissions: true, tools: ["Read", "Write"] } })).toEqual({
    noChrome: true,
    skipPermissions: true,
    tools: ["Read", "Write"],
  });
  expect(extraClaudeFlags({ noChrome: true, skipPermissions: true, tools: ["Read", "Write"] })).toBe(
    " --no-chrome --dangerously-skip-permissions --tools Read,Write",
  );
  expect(extraClaudeFlags({ model: "haiku" })).toBe(" --allowedTools Grep,Glob --model haiku");
  expect(extraClaudeFlags({ codeMode: true })).toBe(" --allowedTools Grep,Glob,REPL");
  expect(extraClaudeFlags({ codeMode: true, tools: ["Read", "Write"] })).toBe(" --tools Read,Write,REPL");
});

test("launch --cwd is the client pwd; session/new.cwd is only a fallback", () => {
  expect(sessionClientCwd("/Users/alice/proj", "/Users/bob/stub")).toBe("/Users/alice/proj");
  expect(sessionClientCwd(undefined, "/Users/bob/stub")).toBe("/Users/bob/stub");
  expect(sessionClientCwd("relative", "/Users/bob/stub")).toBe("/Users/bob/stub");
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
    USER: "alice",
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
    [CODE_MODE_CONFIG_ENV]: "0",
  });
  expect(env.PATH).toBe("/bin");
  expect(env.USER).toBe("alice");
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
  expect(env[CODE_MODE_ENV]).toBeUndefined();
  expect(buildSpawnArgv("sess")[0]).toBe("-c");
});

test("Code Mode env is injected when the config override is on", () => {
  resetConfigForTests({ dir: "Workspace", ws: "home", codeMode: false });
  const env = buildSanitizedEnv({
    PATH: "/bin",
    HOME: "/tmp/iso",
    [CODE_MODE_CONFIG_ENV]: "1",
  });
  expect(env[CODE_MODE_ENV]).toBe("1");
  expect(env[CODE_MODE_CONFIG_ENV]).toBeUndefined();
  expect(collectForwardedEnv({ [CODE_MODE_CONFIG_ENV]: "1" })[CODE_MODE_ENV]).toBe("1");
});

test("local-tool-forward stays off so it cannot race Mods intercept", () => {
  expect(isLocalToolForwardEnabled({ CLAUDE_TUI_LOCAL_TOOL_FORWARD: "1" })).toBe(false);
});
