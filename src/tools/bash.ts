import type { BashOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { appendFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnEnv, withDirenv } from "./direnv.js";
import { pinTuiLocale, workspaceSpawnEnv } from "./workspace-env.js";
import { cancelCall, finishJob, registerJob, wasCancelled } from "./jobs.js";
import { classifyBashIntent, droppedRedundantCd, REDUNDANT_CD_HINT } from "./bash-intent.js";
import { asBool, asNumber, asString, encodeClaudeDir, insideWriteRoot, mapCwd, mergeRoots, rewriteRemoteText } from "./paths.js";
import { abortedShellResult, clampTimeout, killTree, type Send, type ToolFrame } from "./runtime.js";

const MAX_OUTPUT = 30_000;
const MAX_STREAM_HEAD = MAX_OUTPUT + 4_096;
const MAX_STREAM_TAIL = 16_384;
const FG_TIMEOUT_DEFAULT = 120_000;
const FG_TIMEOUT_MAX = 600_000;
const BG_TIMEOUT_DEFAULT = 1_800_000;
const BG_TIMEOUT_MAX = 7_200_000;
const DRAIN_AFTER_TIMEOUT_MS = 2_000;
const cwdBySession = new Map<string, string>();
const CWD_BUILTIN = /\b(?:cd|pushd|popd|chdir)\b/;
const CWD_HINT_TAIL = "directory changes made by the backgrounded command do not apply to subsequent commands.";

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
  mkdirSync(dirname(path), { recursive: true });
  let pending = `${streamSnapshot(buffers.stdout)}${buffers.stderr.tail ? `\n${streamSnapshot(buffers.stderr)}` : ""}`;
  try {
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

export function resetSessionCwd(sessionId: string, agentId?: string): void {
  if (!sessionId) return;
  if (agentId) {
    cwdBySession.delete(cwdKey(sessionId, agentId));
    return;
  }
  cwdBySession.delete(sessionId);
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

async function pump(stream: ReadableStream<Uint8Array> | undefined, into: StreamBuffer): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    appendStream(into, decoder.decode(value, { stream: true }));
  }
  appendStream(into, decoder.decode());
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
): void {
  const callId = frame.callId ?? "";
  const outputFile = taskOutputPath(frame, workspace, proc.pid);
  const stopTee = startTaskTee(outputFile, buffers);
  const timer = setTimeout(() => killTree(proc.pid), remainingMs);
  proc.unref();
  void finished.then(async () => {
    clearTimeout(timer);
    stopTee();
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
  if (asBool(input.run_in_background)) {
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
  const finished = Promise.all([pump(proc.stdout, stdout), pump(proc.stderr, stderrBuf), proc.exited]);
  const raced = await waitWithTimeout(timeoutMs, finished);

  if (raced.timedOut) {
    if (wasCancelled(callId)) return abortRunning(proc, callId, pwdFile, stdout.text, stderrBuf.text);
    await waitWithTimeout(DRAIN_AFTER_TIMEOUT_MS, finished);
    if (wasCancelled(callId)) return abortRunning(proc, callId, pwdFile, stdout.text, stderrBuf.text);
    watchBackground(proc, finished, frame, { stdout, stderr: stderrBuf }, notify, BG_TIMEOUT_DEFAULT, workspace);
    await Bun.file(pwdFile).delete().catch(() => {});
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
  const code = raced.value[2];
  let stderr = clip(stderrBuf.text);
  if (aborted) stderr = append(stderr, "Command was aborted before completion");
  else if (code !== 0) stderr = append(stderr, `Exit code ${code}`);
  return withRedundantCdHint({
    stdout: clip(stdout.text.trimEnd()),
    stderr: stderr.trimEnd(),
    interrupted: aborted,
    ...sandbox,
  }, noteRedundantCd);
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
  registerJob(callId, sessionId, () => killTree(proc.pid), frame.agentId);
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
