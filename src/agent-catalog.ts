import { homedir as osHomedir } from "node:os";
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export interface AgentCatalogEntry {
  value: string;
  displayName: string;
  description?: string;
}

export interface DiscoverAgentsDeps {
  probeClaudeAgents?: () => string | null;
  homedir?: () => string;
  readdirMd?: (dir: string) => string[];
  readFile?: (path: string) => string;
}

export const SAFE_AGENT_NAME = /^[A-Za-z0-9_-]+$/;

export function isSafeAgentName(name: unknown): name is string {
  return typeof name === "string" && SAFE_AGENT_NAME.test(name);
}

export const SAFE_AGENT_REF = /^[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)?$/;

export function isSafeAgentRef(name: unknown): name is string {
  return typeof name === "string" && SAFE_AGENT_REF.test(name);
}

const PROBE_SENTINEL = "__acp_agent_probe_sentinel__";

const DEFAULT_PERSONA = "claude";

function defaultProbeClaudeAgents(): string | null {
  if (process.env.FORK_AGENT_PROBE !== "1") return null;
  try {
    const out = execFileSync("claude", ["--agent", PROBE_SENTINEL], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 8000,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return out.length > 0 ? out : null;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    const out = `${e?.stdout ?? ""}${e?.stderr ?? ""}`;
    return out.length > 0 ? out : null;
  }
}

export function parseAvailableAgents(probeOutput: string): string[] {
  const m = /Available agents:\s*(.+)/.exec(probeOutput);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function entryFromProbeName(name: string): AgentCatalogEntry | null {
  if (name === DEFAULT_PERSONA) return null;
  if (!isSafeAgentRef(name)) return null;
  return { value: name, displayName: name };
}

function defaultReaddirMd(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
}

function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
}

function baseName(filename: string): string {
  return filename.replace(/\.md$/i, "");
}

function humanize(stem: string): string {
  return stem
    .split(/[-_]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

interface Frontmatter {
  name?: string;
  description?: string;
}

export function parseFrontmatter(content: string): Frontmatter {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};

  const out: Frontmatter = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") break;
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key !== "name" && key !== "description") continue;
    let value = m[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length > 0) out[key] = value;
  }
  return out;
}

function resolveEntry(
  dir: string,
  filename: string,
  readFile: (p: string) => string,
): AgentCatalogEntry | null {
  let fm: Frontmatter;
  try {
    fm = parseFrontmatter(readFile(join(dir, filename)));
  } catch {
    return null;
  }

  const stem = baseName(filename);
  const resolvedName = fm.name ?? stem;

  if (!isSafeAgentName(resolvedName)) return null;

  return {
    value: resolvedName,
    displayName: fm.name ?? humanize(stem),
    ...(fm.description ? { description: fm.description } : {}),
  };
}

function sortByValue(entries: AgentCatalogEntry[]): AgentCatalogEntry[] {
  return entries.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

function globDiscoverAgents(cwd: string, deps: DiscoverAgentsDeps): AgentCatalogEntry[] {
  const homedir = deps.homedir ?? osHomedir;
  const readdirMd = deps.readdirMd ?? defaultReaddirMd;
  const readFile = deps.readFile ?? defaultReadFile;

  const projectDir = join(cwd, ".claude", "agents");
  const userDir = join(homedir(), ".claude", "agents");

  const byValue = new Map<string, AgentCatalogEntry>();
  for (const dir of [projectDir, userDir]) {
    for (const filename of readdirMd(dir)) {
      const entry = resolveEntry(dir, filename, readFile);
      if (entry && !byValue.has(entry.value)) {
        byValue.set(entry.value, entry);
      }
    }
  }

  return sortByValue([...byValue.values()]);
}

export function discoverAgents(cwd: string, deps: DiscoverAgentsDeps = {}): AgentCatalogEntry[] {
  const probe = deps.probeClaudeAgents ?? defaultProbeClaudeAgents;
  const probeOut = probe();
  if (probeOut) {
    const byValue = new Map<string, AgentCatalogEntry>();
    for (const name of parseAvailableAgents(probeOut)) {
      const entry = entryFromProbeName(name);
      if (entry && !byValue.has(entry.value)) byValue.set(entry.value, entry);
    }
    if (byValue.size > 0) return sortByValue([...byValue.values()]);
  }

  return globDiscoverAgents(cwd, deps);
}
