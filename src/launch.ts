import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { configDir } from "./config.js";
import pluginManifest from "../plugin/.claude-plugin/plugin.json";
import pluginHooks from "../plugin/hooks/hooks.json";
// @ts-expect-error Bun `type: "text"` is source text, not a module
import pluginRegister from "../plugin/hooks/register.js" with { type: "text" };
import pluginWsClient from "../plugin/hooks/ws-client.js" with { type: "text" };
import pluginWriteFile from "../plugin/hooks/write-file.js" with { type: "text" };

export type Endpoint = { url: string; token: string; cwd: string; tuiRoot: string; helper?: string };

export type SyncFile = { path: string; content: string };

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

export async function stagePlugin(endpoint: Endpoint): Promise<string> {
  const stage = mkdtempSync(join(tmpdir(), "cc-mods-plugin-"));
  await writeMinifiedPlugin(stage, endpoint);
  return stage;
}

const CLAUDE_DIR_EXCLUDES = new Set(["projects", "debug", "file-history", "todos", "sessions"]);
const CLAUDE_FILE_EXCLUDES = new Set(["history.jsonl"]);

/** Project files Claude Code loads at session start. */
export const SESSION_MEMORY_FILES = ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"] as const;

/** Project dirs Claude Code loads: `.claude/` skills/commands/agents, and `.agents/` skills. */
const SESSION_SYNC_DIRS = [".claude", ".agents"] as const;

/**
 * User-level dirs Claude Code loads at session start from `$HOME`.
 * Skills, commands, and agents only — not transcripts, plugins, or credentials.
 */
const HOME_SYNC_DIRS = [
  ".claude/skills",
  ".claude/commands",
  ".claude/agents",
  ".claude/.agents",
  ".agents",
] as const;
const HOME_SYNC_FILES = [".claude/CLAUDE.md"] as const;
const HOME_SYNC_PREFIXES = [
  ".claude/skills/",
  ".claude/commands/",
  ".claude/agents/",
  ".claude/.agents/",
  ".agents/",
] as const;

export function sessionSyncPaths(cwd: string): string[] {
  const paths: string[] = [];
  for (const name of SESSION_SYNC_DIRS) {
    if (existsSync(join(cwd, name))) paths.push(name);
  }
  for (const name of SESSION_MEMORY_FILES) {
    if (existsSync(join(cwd, name))) paths.push(name);
  }
  return paths;
}

export function homeSyncPaths(home: string): string[] {
  const paths: string[] = [];
  for (const name of HOME_SYNC_DIRS) {
    if (existsSync(join(home, name))) paths.push(name);
  }
  for (const name of HOME_SYNC_FILES) {
    if (existsSync(join(home, name))) paths.push(name);
  }
  return paths;
}

function walkFiles(root: string, rel: string, out: SyncFile[]): void {
  const abs = join(root, rel);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    const base = rel.split(/[\\/]/).pop() ?? "";
    if (rel.startsWith(".claude") && CLAUDE_DIR_EXCLUDES.has(base) && rel !== ".claude") return;
    for (const name of readdirSync(abs)) {
      walkFiles(root, join(rel, name), out);
    }
    return;
  }
  const base = rel.split(/[\\/]/).pop() ?? "";
  if (CLAUDE_FILE_EXCLUDES.has(base)) return;
  try {
    out.push({ path: rel.split(sep).join("/"), content: readFileSync(abs, "utf8") });
  } catch {
    /* skip unreadable / binary */
  }
}

function collectFrom(root: string, rels: string[]): SyncFile[] {
  const files: SyncFile[] = [];
  for (const rel of rels) walkFiles(root, rel, files);
  return files;
}

export function collectSessionFiles(cwd: string): SyncFile[] {
  return collectFrom(cwd, sessionSyncPaths(cwd));
}

export function collectHomeFiles(home = homedir()): SyncFile[] {
  return collectFrom(home, homeSyncPaths(home));
}

export function hashSyncFiles(files: SyncFile[]): string {
  const hash = createHash("sha256");
  const rows = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of rows) {
    hash.update(file.path.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

type UrlSync = { home?: Record<string, string>; project?: Record<string, string> };

function syncCachePath(): string {
  return join(configDir(), "sync.json");
}

function loadSyncCache(): Record<string, UrlSync> {
  try {
    const raw = JSON.parse(readFileSync(syncCachePath(), "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, UrlSync>;
  } catch {
    /* missing or unreadable */
  }
  return {};
}

function saveSyncCache(cache: Record<string, UrlSync>): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(syncCachePath(), `${JSON.stringify(cache)}\n`, { mode: 0o600 });
}

export type SyncSelection = {
  files?: SyncFile[];
  homeFiles?: SyncFile[];
  projectHash: string;
  homeHash: string;
};

/** Omit a scope when this machine already synced that hash to `url`. */
export function selectSyncFiles(
  url: string,
  cwd: string,
  home: string,
  files: SyncFile[],
  homeFiles: SyncFile[],
): SyncSelection {
  const projectHash = hashSyncFiles(files);
  const homeHash = hashSyncFiles(homeFiles);
  const entry = loadSyncCache()[url];
  const skipProject = entry?.project?.[cwd] === projectHash;
  const skipHome = entry?.home?.[home] === homeHash;
  return {
    projectHash,
    homeHash,
    ...(skipProject || files.length === 0 ? {} : { files }),
    ...(skipHome || homeFiles.length === 0 ? {} : { homeFiles }),
  };
}

export function rememberSessionSync(url: string, cwd: string, home: string, projectHash: string, homeHash: string): void {
  const cache = loadSyncCache();
  const entry = cache[url] ?? (cache[url] = {});
  entry.project = { ...entry.project, [cwd]: projectHash };
  entry.home = { ...entry.home, [home]: homeHash };
  saveSyncCache(cache);
}

function normalizeRel(path: string): string | undefined {
  const rel = path.replaceAll("\\", "/");
  if (!rel || rel.startsWith("/") || rel.split("/").includes("..")) return undefined;
  return rel;
}

function isInsideRoot(root: string, dest: string): boolean {
  const rel = relative(root, dest);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function allowedHomeRel(rel: string): boolean {
  if ((HOME_SYNC_FILES as readonly string[]).includes(rel)) return true;
  return HOME_SYNC_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

function writeRelFiles(root: string, files: SyncFile[], allow?: (rel: string) => boolean): void {
  mkdirSync(root, { recursive: true });
  for (const file of files) {
    const rel = normalizeRel(file.path);
    if (!rel || (allow && !allow(rel))) continue;
    const dest = join(root, rel);
    if (!isInsideRoot(root, dest)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.content);
  }
}

export function writeSessionFiles(tuiRoot: string, files: SyncFile[]): void {
  writeRelFiles(tuiRoot, files);
}

/** Overlay client user-level skills/agents onto the TUI host `$HOME`. */
export function writeHomeFiles(home: string, files: SyncFile[]): void {
  writeRelFiles(home, files, allowedHomeRel);
}
