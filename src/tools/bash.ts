import type { BashOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { appendFileSync, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnEnv, withDirenv } from "./direnv.js";
import { pinTuiLocale, workspaceSpawnEnv } from "./workspace-env.js";
import { cancelCall, finishJob, getJobOutputFile, promoteJobToBackground, registerJob, wasCancelled } from "./jobs.js";
import { classifyBashIntent, droppedRedundantCd, REDUNDANT_CD_HINT } from "./bash-intent.js";
import { asBool, asNumber, asString, encodeClaudeDir, insideWriteRoot, mapCwd, mergeRoots, rewriteRemoteText } from "./paths.js";
import { detectModifiedReadFiles } from "./read-state.js";
import { abortedShellResult, clampTimeout, killTree, type Send, type ToolFrame } from "./runtime.js";

const MAX_OUTPUT = 30_000;
const MAX_STREAM_HEAD = MAX_OUTPUT + 4_096;
const MAX_STREAM_TAIL = 16_384;
const FG_TIMEOUT_DEFAULT = 120_000;
const FG_TIMEOUT_MAX = 600_000;
const BG_TIMEOUT_DEFAULT = 1_800_000;
const BG_TIMEOUT_MAX = 7_200_000;
const DRAIN_AFTER_TIMEOUT_MS = 2_000;
const POST_EXIT_DRAIN_MS = 250;
const cwdBySession = new Map<string, string>();
const CWD_BUILTIN = /\b(?:cd|pushd|popd|chdir)\b/;
/** Standalone `sleep N` is never auto-backgrounded (matches native Claude Code); compound commands (`sleep 2;cmd`) may auto-background. */
const PURE_SLEEP = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*sleep\s+(?:\d+(?:\.\d+)?[smhd]?|infinity)\s*$/i;
const SAFE_TASK_ID = /^[A-Za-z0-9._-]{1,120}$/;
const CWD_HINT_TAIL = "directory changes made by the backgrounded command do not apply to subsequent commands.";

export type BashExitMeta = { exitCode: number; rawStderr: string };
const exitMetaByResult = new WeakMap<object, BashExitMeta>();

export function getBashExitMeta(result: unknown): BashExitMeta | undefined {
  return result && typeof result === "object" ? exitMetaByResult.get(result) : undefined;
}

function attachExitMeta(result: BashOutput, exitCode: number, rawStderr: string): BashOutput {
  if (exitCode > 0 && exitCode <= 255) {
    exitMetaByResult.set(result, { exitCode, rawStderr });
  }
  return result;
}

const NO_MATCH_BINS = new Set(["grep", "rg", "egrep", "fgrep", "findstr"]);
const DIFF_BINS = new Set(["diff", "fc", "cmp"]);
const SILENT_BINS = new Set(["mkdir", "cp", "mv", "rm", "rmdir", "touch", "chmod", "chown", "ln", "cd", "export", "unset", "true", ":"]);

function finalCommandInfo(command: string): { bin: string; sub: string; andOrGated: boolean } {
  let quote: string | undefined;
  let lastStart = 0;
  let andOrGated = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        i += 1;
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      i += 1;
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      andOrGated = true;
      i += 1;
      lastStart = i + 1;
      continue;
    }
    if (ch === "|" && command[i + 1] === "|") {
      andOrGated = true;
      i += 1;
      lastStart = i + 1;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "\n") {
      if (ch === ";" || ch === "\n") andOrGated = false;
      lastStart = i + 1;
    }
  }
  const tail = command.slice(lastStart).trim();
  const parts = tail.split(/\s+/).filter(Boolean);
  let idx = 0;
  while (idx < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[idx]!)) idx += 1;
  const rawBin = (parts[idx] ?? "").replace(/^["']|["']$/g, "");
  const bin = (rawBin.split(/[\\/]/).pop() ?? rawBin).toLowerCase();
  const sub = (parts[idx + 1] ?? "").replace(/^["']|["']$/g, "").toLowerCase();
  return { bin, sub, andOrGated };
}

/** Native Claude Code Bash semantics: exit 1 from grep/rg/diff is informational, not an error. */
export function interpretExitCode(command: string, code: number): string | undefined {
  if (code !== 1) return undefined;
  const info = finalCommandInfo(command);
  if (info.andOrGated) return undefined;
  if (NO_MATCH_BINS.has(info.bin)) return "No matches found";
  if (DIFF_BINS.has(info.bin)) return "Files differ";
  return undefined;
}

export function expectsNoOutput(command: string): boolean {
  const info = finalCommandInfo(command);
  if (SILENT_BINS.has(info.bin)) return true;
  if (info.bin === "git" && (info.sub === "add" || info.sub === "rm" || info.sub === "mv")) return true;
  return false;
}

function finalizeForeground(
  command: string,
  code: number,
  aborted: boolean,
  stdoutText: string,
  stderrText: string,
  noteRedundantCd: boolean,
  sandbox: Record<string, unknown>,
  sessionId: string,
  cwd: string,
): BashOutput {
  const rawStderr = clip(stderrText);
  const interpretation = !aborted ? interpretExitCode(command, code) : undefined;
  let stderr = rawStderr;
  if (aborted) stderr = append(stderr, "Command was aborted before completion");
  else if (code !== 0 && !interpretation) stderr = append(stderr, `Exit code ${code}`);
  const outClipped = clip(stdoutText.trimEnd());
  const errClipped = stderr.trimEnd();
  const staleHint = !aborted ? detectModifiedReadFiles(sessionId, cwd) : undefined;
  const noOut = !aborted && code === 0 && !outClipped && !errClipped && expectsNoOutput(command);
  const res = withRedundantCdHint({
    stdout: outClipped,
    stderr: errClipped,
    interrupted: aborted,
    ...(interpretation ? { returnCodeInterpretation: interpretation } : {}),
    ...(noOut ? { noOutputExpected: true } : {}),
    ...(staleHint ? { staleReadFileStateHint: staleHint } : {}),
    ...sandbox,
  }, noteRedundantCd);
  if (aborted || interpretation) return res;
  return attachExitMeta(res, code, noteRedundantCd ? append(rawStderr, REDUNDANT_CD_HINT).trimEnd() : rawStderr.trimEnd());
}

type StreamBuffer = {
  text: string;
  tail: string;
  onChunk?: (chunk: string) => void;
};

function makeStreamBuffer(): StreamBuffer {
  return { text: "", tail: "" };
}

function appendStream(buf: StreamBuffer, chunk: string): void {
  if (!chunk) return;
  if (buf.text.length < MAX_STREAM_HEAD) {
    const take = MAX_STREAM_HEAD - buf.text.length;
    buf.text += chunk.slice(0, take);
  }
  buf.tail = (buf.tail + chunk).slice(-MAX_STREAM_TAIL);
  buf.onChunk?.(chunk);
}

function streamSnapshot(buf: StreamBuffer): string {
  return buf.tail.length > buf.text.length || buf.text.length >= MAX_STREAM_HEAD ? buf.tail : buf.text;
}

export { cancelCall };

export { encodeClaudeDir as encodeClaudeTaskDir };

export function claudeTaskOutputPath(cwd: string, sessionId: string, pid: number, uid: number): string {
  return join("/tmp", `claude-${uid}`, encodeClaudeDir(cwd), sessionId, "tasks", `${pid}.output`);
}

function tuiUserId(frame: ToolFrame): number | undefined {
  const raw = frame.tuiUid;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
  return undefined;
}

function taskDirCwd(frame: ToolFrame, workspace: string): string {
  return frame.tuiRoot || frame.cwd || workspace;
}

function taskOutputPath(frame: ToolFrame, workspace: string, pid: number): string | undefined {
  const sessionId = frame.claudeSessionId;
  const uid = tuiUserId(frame);
  if (!sessionId || uid === undefined || process.platform === "win32") return undefined;
  return claudeTaskOutputPath(taskDirCwd(frame, workspace), sessionId, pid, uid);
}

function startTaskTee(
  path: string | undefined,
  buffers: { stdout: StreamBuffer; stderr: StreamBuffer },
): () => void {
  if (!path) return () => {};
  let pending = `${streamSnapshot(buffers.stdout)}${buffers.stderr.tail ? `\n${streamSnapshot(buffers.stderr)}` : ""}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, pending);
    pending = "";
  } catch {
    /* task dir may be unwritable; Monitor/until then keep waiting */
  }
  const onChunk = (chunk: string) => {
    if (pending.length < 256 * 1024) pending += chunk;
  };
  buffers.stdout.onChunk = onChunk;
  buffers.stderr.onChunk = onChunk;
  const flush = () => {
    if (!pending) return;
    const chunk = pending;
    pending = "";
    try {
      appendFileSync(path, chunk);
    } catch {
      /* task dir may be unwritable */
    }
  };
  const timer = setInterval(flush, 250);
  return () => {
    clearInterval(timer);
    buffers.stdout.onChunk = undefined;
    buffers.stderr.onChunk = undefined;
    flush();
  };
}

function cwdKey(sessionId: string, agentId?: string): string {
  return agentId ? `${sessionId}:${agentId}` : sessionId;
}

export function sessionCwd(frame: ToolFrame, workspace: string): string {
  const id = frame.sessionId;
  if (id) {
    if (frame.agentId) {
      const own = cwdBySession.get(cwdKey(id, frame.agentId));
      if (own) return own;
    }
    const next = cwdBySession.get(id);
    if (next) return next;
  }
  return frame.cwd || workspace;
}

function real(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

export function persistCwd(
  workspace: string,
  sessionId: string,
  next: string,
  extraDirs: string[] = [],
  trusted = false,
  agentId?: string,
): void {
  if (!sessionId) return;
  try {
    const root = real(workspace);
    const mapped = mapCwd(root, undefined, real(next), extraDirs, root);
    if (!trusted && !insideWriteRoot(mapped, root, extraDirs)) return;
    cwdBySession.set(cwdKey(sessionId, agentId), mapped);
  } catch {
  }
}

export function resetSessionCwd(sessionId: string, agentId?: string, opts: { allAgents?: boolean } = {}): void {
  if (!sessionId) return;
  if (agentId) {
    cwdBySession.delete(cwdKey(sessionId, agentId));
    return;
  }
  cwdBySession.delete(sessionId);
  if (!opts.allAgents) return;
  const prefix = `${sessionId}:`;
  for (const key of cwdBySession.keys()) {
    if (key.startsWith(prefix)) cwdBySession.delete(key);
  }
}

function shellArgv(tool: string, command: string): string[] {
  if (tool === "PowerShell") {
    const exe = Bun.which("pwsh") || Bun.which("powershell") || Bun.which("powershell.exe");
    if (!exe) throw new Error("PowerShell is not installed on this machine");
    return [exe, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command];
  }
  return ["bash", "-c", `trap 'pwd -P >| "$__CC_PWD"' EXIT\n${command}`];
}

function clip(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n\n... [output truncated]` : text;
}

function append(stderr: string, line: string): string {
  return `${stderr}${stderr ? "\n" : ""}${line}`;
}

function abortedResult(stdout = "", stderr = ""): BashOutput {
  return abortedShellResult(clip(stdout.trimEnd()), clip(stderr.trimEnd()));
}

function backgroundCwdHint(command: string, cwd: string): Record<string, string> {
  if (!CWD_BUILTIN.test(command)) return {};
  return { backgroundCwdHint: `Session cwd remains ${cwd}; ${CWD_HINT_TAIL}` };
}

function abortRunning(
  proc: Bun.Subprocess,
  callId: string,
  pwdFile: string,
  stdout: string,
  stderr: string,
): BashOutput {
  killTree(proc.pid);
  finishJob(callId);
  void Bun.file(pwdFile).delete().catch(() => {});
  return abortedResult(stdout, stderr);
}

export function aliasTaskOutput(callId: string, taskId: string): void {
  if (!callId || !SAFE_TASK_ID.test(taskId)) return;
  const outputFile = getJobOutputFile(callId);
  if (!outputFile) return;
  const targetName = `${taskId}.output`;
  if (basename(outputFile) === targetName) return;
  const alias = join(dirname(outputFile), targetName);
  try {
    mkdirSync(dirname(alias), { recursive: true });
    if (existsSync(alias)) {
      const st = lstatSync(alias);
      if (!st.isFile() || st.size > 0) return;
      const tmp = `${alias}.ln-${process.pid}-${Date.now()}`;
      symlinkSync(outputFile, tmp);
      try {
        renameSync(tmp, alias);
      } catch {
        try { unlinkSync(tmp); } catch { /* ignore */ }
      }
      return;
    }
    symlinkSync(outputFile, alias);
  } catch {
    /* best-effort */
  }
}

type StreamPump = { promise: Promise<void>; cancel: () => void };

function pump(stream: ReadableStream<Uint8Array> | undefined, into: StreamBuffer): StreamPump {
  if (!stream) return { promise: Promise.resolve(), cancel: () => {} };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  const cancel = () => {
    if (stopped) return;
    stopped = true;
    void reader.cancel().catch(() => {});
  };
  const promise = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopped) break;
        appendStream(into, decoder.decode(value, { stream: true }));
      }
      if (!stopped) appendStream(into, decoder.decode());
    } catch {
      /* cancelled or pipe closed */
    }
  })();
  return { promise, cancel };
}

function waitWithTimeout<T>(ms: number, task: Promise<T>): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), ms);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function notifyExit(
  notify: Send,
  frame: ToolFrame,
  pid: number,
  exitCode: number | null,
  aborted: boolean,
  output: string,
  outputFile?: string,
): void {
  notify({
    v: 1,
    type: "notify",
    kind: "background",
    status: "exited",
    callId: frame.callId ?? "",
    sessionId: frame.sessionId,
    agentId: frame.agentId,
    pid,
    exitCode: aborted ? 137 : exitCode,
    interrupted: aborted,
    output: output.slice(-8000),
    outputFile,
  });
}

function watchBackground(
  proc: Bun.Subprocess,
  finished: Promise<unknown>,
  frame: ToolFrame,
  buffers: { stdout: StreamBuffer; stderr: StreamBuffer },
  notify: Send,
  remainingMs: number,
  workspace: string,
  pwdFile?: string,
): void {
  const callId = frame.callId ?? "";
  const outputFile = taskOutputPath(frame, workspace, proc.pid);
  promoteJobToBackground(callId, outputFile);
  const stopTee = startTaskTee(outputFile, buffers);
  const timer = setTimeout(() => killTree(proc.pid), remainingMs);
  proc.unref();
  void finished.then(async () => {
    clearTimeout(timer);
    stopTee();
    if (pwdFile) void Bun.file(pwdFile).delete().catch(() => {});
    const aborted = finishJob(callId);
    const code = typeof proc.exitCode === "number" ? proc.exitCode : await proc.exited;
    notifyExit(
      notify,
      frame,
      proc.pid,
      aborted ? 137 : code,
      aborted,
      `${buffers.stdout.tail}${buffers.stderr.tail ? `\n${buffers.stderr.tail}` : ""}`,
      outputFile,
    );
  });
}

export async function bashTool(
  workspace: string,
  frame: ToolFrame,
  input: Record<string, unknown>,
  notify: Send,
): Promise<BashOutput> {
  const extraDirs = mergeRoots(frame.extraDirs);
  const rewritten = rewriteRemoteText(asString(input.command), workspace, frame.tuiRoot);
  const cwd = sessionCwd(frame, workspace);
  const intent = frame.tool === "PowerShell" ? { action: "run" as const, command: rewritten } : classifyBashIntent(rewritten, cwd);
  if (intent.action === "prefer") throw new Error(intent.message);
  const command = intent.command;
  const noteRedundantCd = frame.tool !== "PowerShell" && droppedRedundantCd(rewritten, cwd);
  const callId = frame.callId ?? "";
  const sessionId = frame.sessionId || "";
  const sandbox = asBool(input.dangerouslyDisableSandbox) === true ? { dangerouslyDisableSandbox: true } : {};

  if (wasCancelled(callId)) return abortedResult();
  const env = pinTuiLocale(await withDirenv(cwd, workspaceSpawnEnv(process.env, frame.tuiEnv)), frame.tuiEnv);
  if (wasCancelled(callId)) return abortedResult();
  const bgDisabled =
    env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS === "1" ||
    process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS === "1";
  if (asBool(input.run_in_background)) {
    if (bgDisabled) throw new Error("Background tasks are disabled (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1)");
    return withRedundantCdHint(
      background(frame, command, cwd, env, notify, clampTimeout(asNumber(input.timeout), BG_TIMEOUT_DEFAULT, 1, BG_TIMEOUT_MAX)),
      noteRedundantCd,
    );
  }

  const pwdFile = join(tmpdir(), `cc-mods-pwd-${process.pid}-${callId || Date.now()}`);
  const argv = shellArgv(frame.tool || "Bash", command);
  const timeoutMs = clampTimeout(asNumber(input.timeout), FG_TIMEOUT_DEFAULT, 1, FG_TIMEOUT_MAX);
  const proc = Bun.spawn(argv, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
    env: spawnEnv({ ...env, __CC_PWD: pwdFile }),
  });
  registerJob(callId, sessionId, () => killTree(proc.pid), frame.agentId);
  if (wasCancelled(callId)) {
    killTree(proc.pid);
    finishJob(callId);
    await Bun.file(pwdFile).delete().catch(() => {});
    return abortedResult();
  }

  const stdout = makeStreamBuffer();
  const stderrBuf = makeStreamBuffer();
  const stdoutPump = pump(proc.stdout, stdout);
  const stderrPump = pump(proc.stderr, stderrBuf);
  const pumpsDone = Promise.all([stdoutPump.promise, stderrPump.promise]);
  // Resolve promptly once the shell itself exits; a detached child (`cmd &`)
  // may inherit stdout/stderr pipes and hold them open long after `proc.exited`.
  const settledAfterExit = proc.exited.then(async (code) => {
    const drained = await waitWithTimeout(POST_EXIT_DRAIN_MS, pumpsDone);
    if (drained.timedOut) {
      stdoutPump.cancel();
      stderrPump.cancel();
    }
    return code;
  });
  const raced = await waitWithTimeout(timeoutMs, settledAfterExit);

  if (raced.timedOut) {
    if (wasCancelled(callId)) {
      stdoutPump.cancel();
      stderrPump.cancel();
      return abortRunning(proc, callId, pwdFile, stdout.text, stderrBuf.text);
    }
    if (bgDisabled || PURE_SLEEP.test(command)) {
      killTree(proc.pid);
      await waitWithTimeout(POST_EXIT_DRAIN_MS, pumpsDone);
      stdoutPump.cancel();
      stderrPump.cancel();
      const aborted = finishJob(callId);
      await Bun.file(pwdFile).delete().catch(() => {});
      let stderr = clip(stderrBuf.text);
      stderr = append(stderr, aborted ? "Command was aborted before completion" : `Command timed out after ${timeoutMs}ms`);
      return withRedundantCdHint({
        stdout: clip(stdout.text.trimEnd()),
        stderr: stderr.trimEnd(),
        interrupted: aborted,
        ...sandbox,
      }, noteRedundantCd);
    }
    const drained = await waitWithTimeout(DRAIN_AFTER_TIMEOUT_MS, settledAfterExit);
    if (wasCancelled(callId)) {
      stdoutPump.cancel();
      stderrPump.cancel();
      return abortRunning(proc, callId, pwdFile, stdout.text, stderrBuf.text);
    }
    if (!drained.timedOut) {
      const aborted = finishJob(callId);
      const nextCwd = (await Bun.file(pwdFile).text().catch(() => "")).trim();
      if (nextCwd) persistCwd(workspace, sessionId, nextCwd, extraDirs, false, frame.agentId);
      await Bun.file(pwdFile).delete().catch(() => {});
      return finalizeForeground(command, drained.value, aborted, stdout.text, stderrBuf.text, noteRedundantCd, sandbox, sessionId, cwd);
    }
    const finished = Promise.all([pumpsDone, proc.exited]);
    watchBackground(proc, finished, frame, { stdout, stderr: stderrBuf }, notify, BG_TIMEOUT_DEFAULT, workspace, pwdFile);
    return withRedundantCdHint({
      stdout: clip(stdout.text.trimEnd()),
      stderr: clip(stderrBuf.text.trimEnd()),
      interrupted: false,
      backgroundTaskId: String(proc.pid),
      timedOutAfterMs: timeoutMs,
      ...backgroundCwdHint(command, cwd),
      ...sandbox,
    }, noteRedundantCd);
  }

  const aborted = finishJob(callId);
  const nextCwd = (await Bun.file(pwdFile).text().catch(() => "")).trim();
  if (nextCwd) persistCwd(workspace, sessionId, nextCwd, extraDirs, false, frame.agentId);
  await Bun.file(pwdFile).delete().catch(() => {});
  return finalizeForeground(command, raced.value, aborted, stdout.text, stderrBuf.text, noteRedundantCd, sandbox, sessionId, cwd);
}

function withRedundantCdHint(result: BashOutput, dropped: boolean): BashOutput {
  if (!dropped) return result;
  return { ...result, stderr: append(result.stderr, REDUNDANT_CD_HINT) };
}

function background(
  frame: ToolFrame,
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  notify: Send,
  timeoutMs: number,
): BashOutput {
  const uid = tuiUserId(frame);
  const claudeSessionId = frame.claudeSessionId;
  const taskDir =
    claudeSessionId && uid !== undefined && process.platform !== "win32"
      ? join("/tmp", `claude-${uid}`, encodeClaudeDir(taskDirCwd(frame, cwd)), claudeSessionId, "tasks")
      : undefined;
  const staging = join(tmpdir(), `cc-mods-bg-${process.pid}-${Date.now()}.log`);
  mkdirSync(taskDir ?? tmpdir(), { recursive: true });
  const script = taskDir
    ? `mkdir -p "$TASK_DIR"\nexec >>"$TASK_DIR/$$.output" 2>&1\n${command}`
    : `exec >>"$OUT" 2>&1\n${command}`;
  const proc = Bun.spawn(["bash", "-c", script], {
    cwd,
    env: spawnEnv({ ...env, ...(taskDir ? { TASK_DIR: taskDir } : { OUT: staging }) }),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  const callId = frame.callId ?? "";
  const sessionId = frame.sessionId || "";
  const id = String(proc.pid);
  const output = taskDir ? join(taskDir, `${id}.output`) : staging;
  registerJob(callId, sessionId, () => killTree(proc.pid), frame.agentId, { background: true, outputFile: output });
  const timer = setTimeout(() => killTree(proc.pid), timeoutMs);
  proc.unref();
  void proc.exited.then(async (exitCode) => {
    clearTimeout(timer);
    const aborted = finishJob(callId);
    const file = Bun.file(output);
    const st = await file.stat().catch(() => null);
    const tail = st && st.size > MAX_STREAM_TAIL
      ? await file.slice(st.size - MAX_STREAM_TAIL, st.size).text().catch(() => "")
      : await file.text().catch(() => "");
    notifyExit(notify, frame, proc.pid, aborted ? 137 : exitCode, aborted, tail, output);
  });
  if (wasCancelled(callId)) {
    killTree(proc.pid);
    return abortedResult();
  }
  return {
    stdout: `Command running in background with ID: ${id}. Output is being written to: ${output}.`,
    stderr: "",
    interrupted: false,
    backgroundTaskId: id,
    ...backgroundCwdHint(command, cwd),
  };
}
