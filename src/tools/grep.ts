import { finishJob, registerJob, wasCancelled } from "./jobs.js";
import { asBool, asNumber, asString, mapPath } from "./paths.js";

type Mode = "content" | "files_with_matches" | "count";

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
  if (rg) {
    return [
      rg, "--hidden", "--glob", "!.git", "--glob", "!node_modules", "--max-columns", "500",
      ...flags,
      ...(asBool(input.multiline) ? ["-U", "--multiline-dotall"] : []),
      ...(asString(input.glob) ? ["--glob", asString(input.glob)] : []),
      ...(asString(input.type) ? ["--type", asString(input.type)] : []),
      "-e", asString(input.pattern), "--", path,
    ];
  }
  if (!grep) throw new Error("Grep needs ripgrep (rg) or grep on PATH");
  return [
    grep, "-r", "-E", "-I", "--exclude-dir=.git", "--exclude-dir=node_modules",
    ...flags,
    ...(asString(input.glob) ? [`--include=${asString(input.glob)}`] : []),
    "-e", asString(input.pattern), "--", path,
  ];
}

export async function grepTool(
  cwd: string,
  tuiRoot: string | undefined,
  input: Record<string, unknown>,
  extraDirs: string[] = [],
  callId = "",
  sessionId = "",
) {
  const mode: Mode = asString(input.output_mode) === "content" || asString(input.output_mode) === "count"
    ? asString(input.output_mode) as Mode
    : "files_with_matches";
  const path = mapPath(cwd, tuiRoot, asString(input.path, ".") || ".", extraDirs);
  if (wasCancelled(callId)) throw new Error("Tool call was cancelled");
  const proc = Bun.spawn(argv(input, mode, path), { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  registerJob(callId, sessionId, () => {
    try { proc.kill(); } catch { /* already gone */ }
  });
  let out = "";
  let error = "";
  let code: number | null = 0;
  try {
    [out, error, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  } finally {
    if (finishJob(callId)) throw new Error("Tool call was cancelled");
  }
  if (code > 1) throw new Error(error.trim() || `search failed with exit code ${code}`);

  let lines = out.split("\n").filter(Boolean);
  if (mode === "count") lines = lines.filter((line) => !line.endsWith(":0"));
  const offset = Math.max(0, asNumber(input.offset) ?? 0);
  const head = asNumber(input.head_limit);
  const unlimited = head === 0;
  const limit = unlimited ? undefined : (head ?? 250);
  const sliced = lines.slice(offset, limit === undefined ? undefined : offset + limit);
  const filenames = [...new Set(sliced.map((line) => (mode === "content" ? line.split(":", 1)[0]! : mode === "count" ? line.replace(/:\d+$/, "") : line)))];
  return {
    mode,
    numFiles: filenames.length,
    filenames,
    ...(mode === "content" ? { content: sliced.join("\n"), numLines: sliced.length } : {}),
    ...(mode === "count" ? { content: sliced.join("\n"), numMatches: sliced.reduce((n, line) => n + (Number(line.split(":").at(-1)) || 0), 0) } : {}),
    appliedLimit: limit,
    appliedOffset: offset || undefined,
  };
}
