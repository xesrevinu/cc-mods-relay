import { homedir as osHomedir } from "node:os";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AvailableCommand } from "@agentclientprotocol/sdk/unstable";

function cmd(name: string, description: string, hint?: string): AvailableCommand {
  return hint ? { name, description, input: { hint } } : { name, description };
}

/**
 * Slash commands we advertise. They are answered by the ACP agent (config
 * options, usage_update, session snapshot, rename) — not by waiting on a TUI turn.
 * Project `.claude/commands` and skills are discovered separately.
 */
export const BUILTIN_COMMANDS: readonly AvailableCommand[] = [
  cmd("context", "Show context occupancy by category", "all"),
  cmd("effort", "Set thinking intensity for this session", "low|medium|high|xhigh|max|auto"),
  cmd("fast", "Toggle faster Opus output", "on|off"),
  cmd("model", "Switch the model for this session", "model"),
  cmd("rename", "Rename the current session", "<title>"),
  cmd("usage", "Show session cost, plan rate limits, and token buckets"),
];

export interface DiscoverCommandsDeps {
  homedir?: () => string;
  readdirMd?: (dir: string) => string[];
  readdirDirs?: (dir: string) => string[];
  readFile?: (path: string) => string;
  builtins?: readonly AvailableCommand[];
}

export const SAFE_COMMAND_NAME = /^[a-z0-9_-]+$/;

export function isSafeCommandName(name: unknown): name is string {
  return typeof name === "string" && SAFE_COMMAND_NAME.test(name);
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

function defaultReaddirDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
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

interface CommandFrontmatter {
  description?: string;
  argumentHint?: string;
}

export function parseCommandFrontmatter(content: string): CommandFrontmatter {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};

  const out: CommandFrontmatter = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") break;
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key !== "description" && key !== "argument-hint") continue;
    let value = m[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length === 0) continue;
    if (key === "description") out.description = value;
    else out.argumentHint = value;
  }
  return out;
}

function resolveEntry(
  dir: string,
  filename: string,
  readFile: (p: string) => string,
): AvailableCommand | null {
  const name = baseName(filename);

  if (!isSafeCommandName(name)) {
    if (process.env.FORK_COMMAND_DEBUG === "1") {
      process.stderr.write(
        `[command-catalog] dropped unsafe command name: ${JSON.stringify(name)}\n`,
      );
    }
    return null;
  }

  let fm: CommandFrontmatter;
  try {
    fm = parseCommandFrontmatter(readFile(join(dir, filename)));
  } catch {
    return null;
  }

  const description = fm.description ?? "";
  return {
    name,
    description,
    ...(fm.argumentHint ? { input: { hint: fm.argumentHint } } : {}),
  };
}

function resolveSkillEntry(
  skillsDir: string,
  subdirName: string,
  readFile: (p: string) => string,
): AvailableCommand | null {
  const name = subdirName;

  if (!isSafeCommandName(name)) {
    if (process.env.FORK_COMMAND_DEBUG === "1") {
      process.stderr.write(
        `[command-catalog] dropped unsafe skill name: ${JSON.stringify(name)}\n`,
      );
    }
    return null;
  }

  let fm: CommandFrontmatter;
  try {
    fm = parseCommandFrontmatter(readFile(join(skillsDir, subdirName, "SKILL.md")));
  } catch {
    return null;
  }

  const description = fm.description ?? "";
  return { name, description };
}

function sortByName(entries: AvailableCommand[]): AvailableCommand[] {
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function readEnabledMarketplaces(home: string, readFile: (p: string) => string): Set<string> {
  const path = join(home, ".claude", "plugins", "installed_plugins.json");

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(path));
  } catch {
    return new Set();
  }

  const enabled = new Set<string>();
  const plugins = (parsed as { plugins?: unknown } | null)?.plugins;
  if (typeof plugins !== "object" || plugins === null || Array.isArray(plugins)) return enabled;

  for (const [key, value] of Object.entries(plugins as Record<string, unknown>)) {
    if (!Array.isArray(value) || value.length === 0) continue;
    const at = key.lastIndexOf("@");
    if (at < 0) continue;
    const marketplace = key.slice(at + 1);
    if (marketplace.length > 0) enabled.add(marketplace);
  }
  return enabled;
}

type DiskSource = { kind: "commands"; dir: string } | { kind: "skills"; dir: string };

export function discoverCommands(cwd: string, deps: DiscoverCommandsDeps = {}): AvailableCommand[] {
  const homedir = deps.homedir ?? osHomedir;
  const readdirMd = deps.readdirMd ?? defaultReaddirMd;
  const readdirDirs = deps.readdirDirs ?? defaultReaddirDirs;
  const readFile = deps.readFile ?? defaultReadFile;
  const builtins = deps.builtins ?? BUILTIN_COMMANDS;

  const home = homedir();
  const userSources: readonly DiskSource[] = [
    { kind: "commands", dir: join(cwd, ".claude", "commands") },
    { kind: "skills", dir: join(cwd, ".claude", "skills") },
    { kind: "commands", dir: join(home, ".claude", "commands") },
    { kind: "skills", dir: join(home, ".claude", "skills") },
  ];

  const byName = new Map<string, AvailableCommand>();
  const add = (entry: AvailableCommand | null): void => {
    if (entry && !byName.has(entry.name)) byName.set(entry.name, entry);
  };
  const foldSource = (source: DiskSource): void => {
    if (source.kind === "commands") {
      for (const filename of readdirMd(source.dir))
        add(resolveEntry(source.dir, filename, readFile));
    } else {
      for (const subdir of readdirDirs(source.dir))
        add(resolveSkillEntry(source.dir, subdir, readFile));
    }
  };

  for (const source of userSources) foldSource(source);

  const marketplacesDir = join(home, ".claude", "plugins", "marketplaces");
  const enabled = readEnabledMarketplaces(home, readFile);
  for (const m of readdirDirs(marketplacesDir)) {
    if (!enabled.has(m)) continue;
    foldSource({ kind: "commands", dir: join(marketplacesDir, m, "commands") });
    foldSource({ kind: "skills", dir: join(marketplacesDir, m, "skills") });
  }

  for (const item of builtins) {
    if (isSafeCommandName(item.name) && !byName.has(item.name)) byName.set(item.name, item);
  }

  return sortByName([...byName.values()]);
}
