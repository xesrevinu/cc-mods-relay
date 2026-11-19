import type { GlobOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { statSync } from "node:fs";
import { join } from "node:path";
import { finishJob, registerJob, wasCancelled } from "./jobs.js";
import { asString, mapReadPath } from "./paths.js";

const LIMIT = 100;
const STAT_BATCH = 64;

export const DEFAULT_IGNORE_DIRS = [
  ".git",
  "node_modules",
  "target",
  ".build",
  "DerivedData",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  "Pods",
  "Carthage",
] as const;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function explicitDirs(pattern: string, root: string): Set<string> {
  const out = new Set<string>();
  for (const dir of DEFAULT_IGNORE_DIRS) {
    const re = new RegExp(`(^|[\\\\/])${escapeRegex(dir)}($|[\\\\/])`);
    if (re.test(pattern) || re.test(root)) out.add(dir);
  }
  return out;
}

function skipPattern(skipped: string[]): RegExp | undefined {
  if (!skipped.length) return undefined;
  return new RegExp(`(^|[\\\\/])(${skipped.map(escapeRegex).join("|")})([\\\\/]|$)`);
}

async function rgCandidateFiles(
  root: string,
  skipped: string[],
  useGitignore: boolean,
  callId: string,
  sessionId: string,
  agentId?: string,
): Promise<string[] | undefined> {
  const rg = Bun.which("rg");
  if (!rg) return undefined;
  const args = [
    rg,
    "--files",
    "--hidden",
    "--null",
    "--no-ignore-parent",
    "--no-require-git",
    ...(useGitignore ? [] : ["--no-ignore"]),
    ...skipped.flatMap((dir) => ["--glob", `!**/${dir}/**`]),
    "--",
    ".",
  ];
  if (wasCancelled(callId)) throw new Error("Tool call was cancelled");
  const proc = Bun.spawn(args, { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  registerJob(callId, sessionId, () => {
    try { proc.kill(); } catch { /* already gone */ }
  }, agentId);
  let buf: ArrayBuffer;
  let code: number;
  try {
    [buf, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
  } catch {
    if (finishJob(callId)) throw new Error("Tool call was cancelled");
    return undefined;
  }
  if (finishJob(callId)) throw new Error("Tool call was cancelled");
  if (code !== 0 && code !== 1) return undefined;
  const text = new TextDecoder().decode(buf);
  if (!text) return [];
  return text
    .split("\0")
    .filter(Boolean)
    .map((p) => p.replace(/^\.[\\/]/, ""));
}

async function boundedStatTimes(paths: string[], callId: string): Promise<readonly (readonly [string, number])[]> {
  const out: (readonly [string, number])[] = [];
  for (let i = 0; i < paths.length; i += STAT_BATCH) {
    if (wasCancelled(callId)) throw new Error("Tool call was cancelled");
    const slice = paths.slice(i, i + STAT_BATCH);
    const batch = await Promise.all(
      slice.map(async (f) => [f, (await Bun.file(f).stat().catch(() => null))?.mtime.getTime() ?? 0] as const),
    );
    out.push(...batch);
  }
  return out;
}

export async function globTool(
  cwd: string,
  tuiRoot: string | undefined,
  input: Record<string, unknown>,
  extraDirs: string[] = [],
  project?: string,
  callId = "",
  sessionId = "",
  agentId?: string,
): Promise<GlobOutput> {
  const started = performance.now();
  const pattern = asString(input.pattern);
  const root = mapReadPath(cwd, tuiRoot, asString(input.path, ".") || ".", extraDirs, project);
  const st = statSync(root);
  if (!st.isDirectory()) throw new Error(`ENOTDIR: not a directory, scandir '${root}'`);

  const keep = explicitDirs(pattern, root);
  const skipped = DEFAULT_IGNORE_DIRS.filter((dir) => !keep.has(dir));
  const useGitignore = keep.size === 0;
  const matcher = new Bun.Glob(pattern);

  const files: string[] = [];
  const candidates = await rgCandidateFiles(root, skipped, useGitignore, callId, sessionId, agentId);
  if (candidates !== undefined) {
    for (const rel of candidates) {
      if (matcher.match(rel)) files.push(join(root, rel));
    }
  } else {
    const skipRe = skipPattern(skipped);
    for await (const file of matcher.scan({ cwd: root, dot: true, onlyFiles: true })) {
      if (wasCancelled(callId)) throw new Error("Tool call was cancelled");
      if (!skipRe || !skipRe.test(file)) files.push(join(root, file));
    }
  }

  const dated = await boundedStatTimes(files, callId);
  const sorted = [...dated].sort((a, b) => b[1] - a[1]);
  const filenames = sorted.slice(0, LIMIT).map(([f]) => f);
  return {
    durationMs: Math.round(performance.now() - started),
    numFiles: filenames.length,
    filenames,
    truncated: files.length > LIMIT,
    totalMatches: files.length,
    countIsComplete: true,
  };
}
