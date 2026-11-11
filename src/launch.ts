import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEnvironmentAppend, ENVIRONMENT_FILE } from "./environment.js";
import { quote, remoteHome, rsh } from "./ssh.js";
import pluginManifest from "../plugin/.claude-plugin/plugin.json";
import pluginHooks from "../plugin/hooks/hooks.json";
// @ts-expect-error Bun `type: "text"` is source text, not a module
import pluginRegister from "../plugin/hooks/register.js" with { type: "text" };
import pluginWsClient from "../plugin/hooks/ws-client.js" with { type: "text" };
import pluginWriteFile from "../plugin/hooks/write-file.js" with { type: "text" };
import embeddedAgent from "./embedded-agent.js" with { type: "text" };

export type Endpoint = { url: string; token: string; cwd: string; tuiRoot: string; helper?: string };

const ENDPOINT_SENTINEL = 'const ENDPOINT = {"url":"","token":"","cwd":"","tuiRoot":"","helper":"","extraDirs":[]};';

const PLUGIN_FILES: Record<string, string> = {
  ".claude-plugin/plugin.json": `${JSON.stringify(pluginManifest, null, 2)}\n`,
  "hooks/hooks.json": `${JSON.stringify(pluginHooks, null, 2)}\n`,
  "hooks/register.js": pluginRegister as unknown as string,
  "hooks/ws-client.js": pluginWsClient as unknown as string,
  "hooks/write-file.js": pluginWriteFile as unknown as string,
};

function readPlugin(rel: string): string {
  const text = PLUGIN_FILES[rel];
  if (text == null) throw new Error(`unknown plugin file: ${rel}`);
  return text;
}

function compiledBinary(): boolean {
  return import.meta.dir.includes("$bunfs");
}

async function minifyJs(source: string, filename: string, target: "bun" | "browser"): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), "cc-mods-minify-"));
  const input = join(scratch, filename);
  try {
    await Bun.write(input, source);
    const result = await Bun.build({
      entrypoints: [input],
      minify: true,
      target,
      format: "esm",
    });
    if (!result.success || !result.outputs[0]) {
      const logs = result.logs.map((log) => String(log)).join("\n");
      throw new Error(`plugin ${filename} minify failed: ${logs || "no output"}`);
    }
    return (await result.outputs[0].text()).replace(/^\/\/ @bun\n/, "");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function bakedRegister(endpoint: Endpoint, helper: string): Promise<string> {
  const registerSource = readPlugin("hooks/register.js");
  const baked = registerSource.replace(
    ENDPOINT_SENTINEL,
    `const ENDPOINT = ${JSON.stringify({ ...endpoint, helper, extraDirs: [] })};`,
  );
  if (baked === registerSource) throw new Error("plugin register.js is missing the ENDPOINT sentinel");
  return baked;
}

async function writeMinifiedPlugin(stage: string, endpoint: Endpoint): Promise<string> {
  const helper = endpoint.helper ?? join(stage, "hooks/ws-client.js");
  mkdirSync(join(stage, ".claude-plugin"), { recursive: true });
  mkdirSync(join(stage, "hooks"), { recursive: true });
  writeFileSync(join(stage, ".claude-plugin/plugin.json"), readPlugin(".claude-plugin/plugin.json"));
  writeFileSync(join(stage, "hooks/hooks.json"), readPlugin("hooks/hooks.json"));
  writeFileSync(join(stage, "hooks/register.js"), await minifyJs(await bakedRegister(endpoint, helper), "register.js", "browser"));
  writeFileSync(join(stage, "hooks/ws-client.js"), await minifyJs(readPlugin("hooks/ws-client.js"), "ws-client.js", "bun"));
  writeFileSync(join(stage, "hooks/write-file.js"), await minifyJs(readPlugin("hooks/write-file.js"), "write-file.js", "bun"));
  return helper;
}

async function bakeEnvironment(stage: string, endpoint: Endpoint): Promise<void> {
  if (!endpoint.tuiRoot || endpoint.tuiRoot === endpoint.cwd) return;
  writeFileSync(join(stage, ENVIRONMENT_FILE), await buildEnvironmentAppend(endpoint.cwd));
}

export async function stagePlugin(endpoint: Endpoint): Promise<string> {
  const stage = mkdtempSync(join(tmpdir(), "cc-mods-plugin-"));
  await writeMinifiedPlugin(stage, endpoint);
  await bakeEnvironment(stage, endpoint);
  return stage;
}

async function tarToHost(host: string, stage: string, dest: string): Promise<void> {
  const tar = Bun.spawn(["tar", "-czf", "-", "-C", stage, "."], { stdout: "pipe", stderr: "pipe" });
  const ssh = Bun.spawn(
    [...rsh(), "-T", host, `mkdir -p ${quote(dest)} && tar -xzf - -C ${quote(dest)}`],
    { stdin: tar.stdout, stdout: "ignore", stderr: "pipe" },
  );
  const code = await ssh.exited;
  await tar.exited;
  if (code !== 0) throw new Error(`upload failed: ${(await new Response(ssh.stderr).text()).trim()}`);
}

const CLAUDE_TAR_EXCLUDES = [
  "--exclude",
  ".claude/projects",
  "--exclude",
  ".claude/debug",
  "--exclude",
  ".claude/file-history",
  "--exclude",
  ".claude/history.jsonl",
  "--exclude",
  ".claude/todos",
  "--exclude",
  ".claude/sessions",
];

/** Project files Claude Code loads at session start, plus `.claude/` skills/commands. */
export const SESSION_MEMORY_FILES = ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"] as const;

export function sessionSyncPaths(cwd: string): string[] {
  const paths: string[] = [];
  if (existsSync(join(cwd, ".claude"))) paths.push(".claude");
  for (const name of SESSION_MEMORY_FILES) {
    if (existsSync(join(cwd, name))) paths.push(name);
  }
  return paths;
}

/** Copy project memory files and `.claude/` onto the host session cwd. */
export async function syncProjectClaude(host: string, cwd: string, tuiRoot: string): Promise<void> {
  const paths = sessionSyncPaths(cwd);
  if (!paths.length) return;
  const tar = Bun.spawn(["tar", "-czf", "-", "-C", cwd, ...CLAUDE_TAR_EXCLUDES, ...paths], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const ssh = Bun.spawn(
    [...rsh(), "-T", host, `mkdir -p ${quote(tuiRoot)} && tar -xzf - -C ${quote(tuiRoot)}`],
    { stdin: tar.stdout, stdout: "ignore", stderr: "pipe" },
  );
  const code = await ssh.exited;
  await tar.exited;
  if (code !== 0) throw new Error(`sync session files failed: ${(await new Response(ssh.stderr).text()).trim()}`);
}

export async function uploadPlugin(host: string, endpoint: Endpoint): Promise<string> {
  const home = await remoteHome(host);
  const dest = `${home}/.cc-mods-relay/plugin`;
  const stage = mkdtempSync(join(tmpdir(), "cc-mods-plugin-"));
  await writeMinifiedPlugin(stage, { ...endpoint, helper: `${dest}/hooks/ws-client.js` });
  await bakeEnvironment(stage, endpoint);
  await tarToHost(host, stage, dest);
  return dest;
}

async function bundleAgent(): Promise<string> {
  if (!compiledBinary()) {
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, "agent.ts")],
      target: "bun",
      minify: true,
    });
    if (!result.success || !result.outputs[0]) {
      const logs = result.logs.map((log) => String(log)).join("\n");
      throw new Error(`agent bundle failed: ${logs || "no output"}`);
    }
    return await result.outputs[0].text();
  }
  const agent = embeddedAgent as unknown as string;
  if (agent.includes("embedded agent missing")) {
    throw new Error("agent bundle was not compiled into this binary");
  }
  return agent;
}

export async function uploadAgent(host: string): Promise<string> {
  const home = await remoteHome(host);
  const dest = `${home}/.cc-mods-relay/agent.js`;
  const stage = mkdtempSync(join(tmpdir(), "cc-mods-agent-"));
  await Bun.write(join(stage, "agent.js"), await bundleAgent());
  const tar = Bun.spawn(["tar", "-czf", "-", "-C", stage, "agent.js"], { stdout: "pipe", stderr: "pipe" });
  const ssh = Bun.spawn(
    [...rsh(), "-T", host, `mkdir -p ${quote(`${home}/.cc-mods-relay`)} && tar -xzf - -C ${quote(`${home}/.cc-mods-relay`)}`],
    { stdin: tar.stdout, stdout: "ignore", stderr: "pipe" },
  );
  const code = await ssh.exited;
  await tar.exited;
  if (code !== 0) throw new Error(`agent upload failed: ${(await new Response(ssh.stderr).text()).trim()}`);
  return dest;
}
