import type { GrepOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { finishJob, registerJob, wasCancelled } from "./jobs.js";
import { asBool, asNumber, asString, mapReadPath } from "./paths.js";

type Mode = "content" | "files_with_matches" | "count";

/** Keep Grep content well under Mods' ~4 MiB hook-join / JSON limit. */
export const GREP_CONTENT_BYTE_CAP = 1_500_000;

function splitGlobs(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  // Keep brace expressions intact (`*.{ts,tsx}`); split space-separated globs (`*.ts *.tsx`).
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  for (const ch of trimmed) {
    if (ch === "{") depth += 1;
    else if (ch === "}" && depth > 0) depth -= 1;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function explicitTarget(dir: string, path: string, globs: string[]): boolean {
  const re = new RegExp(`(^|[\\\\/])${dir.replace(".", "\\.")}($|[\\\\/])`);
  if (re.test(path)) return true;
  return globs.some((g) => !g.startsWith("!") && re.test(g));
}

function argv(input: Record<string, unknown>, mode: Mode, path: string): string[] {
  const rg = Bun.which("rg");
  const grep = Bun.which("grep");
  const context: string[] = [];
  const a = asNumber(input["-A"]);
  const b = asNumber(input["-B"]);
  const c = asNumber(input["-C"]) ?? asNumber(input.context);
  if (mode === "content") {
    if (c !== undefined) context.push("-C", String(c));
    else {
      if (b !== undefined) context.push("-B", String(b));
      if (a !== undefined) context.push("-A", String(a));
    }
  }
  const flags = [
    ...(asBool(input["-i"]) ? ["-i"] : []),
    ...(mode === "files_with_matches" ? ["-l"] : mode === "count" ? ["-c"] : asBool(input["-n"]) === false ? [] : ["-n"]),
    ...(mode === "content" && asBool(input["-o"]) ? ["-o"] : []),
    ...context,
  ];
  const globs = splitGlobs(asString(input.glob));
  const skipGit = !explicitTarget(".git", path, globs);
  const skipNodeModules = !explicitTarget("node_modules", path, globs);
  if (rg) {
    return [
      rg, "--hidden",
      ...(skipGit ? ["--glob", "!.git"] : []),
      ...(skipNodeModules ? ["--glob", "!node_modules"] : []),
      "--max-columns", "500",
      ...(mode === "content" || mode === "count" ? ["--with-filename"] : []),
      ...flags,
      ...(asBool(input.multiline) ? ["-U", "--multiline-dotall"] : []),
      ...globs.flatMap((g) => ["--glob", g]),
      ...(asString(input.type) ? ["--type", asString(input.type)] : []),
      "-e", asString(input.pattern), "--", path,
    ];
  }
  if (!grep) throw new Error("Grep needs ripgrep (rg) or grep on PATH");
  return [
    grep, "-r", "-E", "-I",
    ...(skipGit ? ["--exclude-dir=.git"] : []),
    ...(skipNodeModules ? ["--exclude-dir=node_modules"] : []),
    ...(mode === "content" || mode === "count" ? ["-H"] : []),
    ...flags,
    ...globs.map((g) => `--include=${g}`),
    "-e", asString(input.pattern), "--", path,
  ];
}

function contentFilename(line: string, numbered: boolean, known: Set<string>): string | undefined {
  if (line === "--") return undefined;
  if (numbered) {
    const match = line.match(/^(.+?)(?::\d+:|-\d+-)/);
    if (match) {
      known.add(match[1]!);
      return match[1];
    }
  }
  for (const name of known) {
    if (line.startsWith(`${name}:`) || line.startsWith(`${name}-`)) return name;
  }
  const idx = line.indexOf(":");
  if (idx >= 0) {
    const name = line.slice(0, idx);
    known.add(name);
    return name;
  }
  return undefined;
}

function capLinesUtf8(lines: string[], maxBytes: number): { lines: string[]; truncated: boolean } {
  const out: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const b = Buffer.byteLength(line, "utf8");
    const extra = out.length === 0 ? b : 1 + b;
    if (bytes + extra > maxBytes) {
      if (out.length === 0) out.push(`${line.slice(0, Math.min(line.length, 2000))}…`);
      return { lines: out, truncated: true };
    }
    bytes += extra;
    out.push(line);
  }
  return { lines: out, truncated: false };
}

export async function grepTool(
  cwd: string,
  tuiRoot: string | undefined,
  input: Record<string, unknown>,
  extraDirs: string[] = [],
  callId = "",
  sessionId = "",
  project?: string,
  agentId?: string,
): Promise<GrepOutput> {
  const mode: Mode = asString(input.output_mode) === "content" || asString(input.output_mode) === "count"
    ? asString(input.output_mode) as Mode
    : "files_with_matches";
  const path = mapReadPath(cwd, tuiRoot, asString(input.path, ".") || ".", extraDirs, project);
  if (wasCancelled(callId)) throw new Error("Tool call was cancelled");
  const proc = Bun.spawn(argv(input, mode, path), { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  registerJob(callId, sessionId, () => {
    try { proc.kill(); } catch { /* already gone */ }
  }, agentId);
  let out = "";
  let error = "";
  let code: number | null = 0;
  try {
    [out, error, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  } finally {
    if (finishJob(callId)) throw new Error("Tool call was cancelled");
  }
  if (code > 1 && !(code === 2 && out.length > 0)) {
    throw new Error(error.trim() || `search failed with exit code ${code}`);
  }

  let lines = out.split("\n").filter(Boolean);
  if (mode === "count") lines = lines.filter((line) => !line.endsWith(":0"));
  const offset = Math.max(0, asNumber(input.offset) ?? 0);
  const head = asNumber(input.head_limit);
  const unlimited = head === 0;
  const limit = unlimited ? undefined : (head ?? 250);
  const sliced = lines.slice(offset, limit === undefined ? undefined : offset + limit);
  const capped = capLinesUtf8(sliced, GREP_CONTENT_BYTE_CAP);
  const numbered = asBool(input["-n"]) !== false;
  const knownFiles = new Set<string>();
  const rawFilenames = [
    ...new Set(
      capped.lines
        .map((line) =>
          mode === "content"
            ? contentFilename(line, numbered, knownFiles)
            : mode === "count"
              ? line.replace(/:\d+$/, "")
              : line,
        )
        .filter((f): f is string => Boolean(f)),
    ),
  ];
  const filenames = mode === "content" && !numbered
    ? rawFilenames.filter((cand) => !rawFilenames.some((other) => other !== cand && cand.startsWith(`${other}-`)))
    : rawFilenames;
  const contentText = capped.truncated
    ? `${capped.lines.join("\n")}\n… [output truncated to fit tool result limit]`
    : capped.lines.join("\n");
  return {
    mode,
    numFiles: filenames.length,
    filenames,
    ...(mode === "files_with_matches" ? { totalFiles: lines.length } : {}),
    ...(mode === "content" ? { content: contentText, numLines: capped.lines.length, totalLines: lines.length } : {}),
    ...(mode === "count" ? { content: contentText, numMatches: capped.lines.reduce((n, line) => n + (Number(line.split(":").at(-1)) || 0), 0) } : {}),
    ...(limit !== undefined ? { appliedLimit: limit } : {}),
    ...(offset > 0 ? { appliedOffset: offset } : {}),
  };
}
