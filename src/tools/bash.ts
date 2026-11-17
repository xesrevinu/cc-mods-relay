import type { BashOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnEnv, withDirenv } from "./direnv.js";
import { cancelCall, finishJob, registerJob, wasCancelled } from "./jobs.js";
import { asBool, asNumber, asString, mapCwd, mergeRoots, rewriteRemoteText } from "./paths.js";
import { abortedShellResult, clampTimeout, killTree, type Send, type ToolFrame } from "./runtime.js";

const MAX_OUTPUT = 30_000;
const FG_TIMEOUT_DEFAULT = 120_000;
const FG_TIMEOUT_MAX = 600_000;
const BG_TIMEOUT_DEFAULT = 1_800_000;
const BG_TIMEOUT_MAX = 7_200_000;
const DRAIN_AFTER_TIMEOUT_MS = 2_000;
const cwdBySession = new Map<string, string>();
const CWD_BUILTIN = /\b(?:cd|pushd|popd|chdir)\b/;
const CWD_HINT_TAIL = "directory changes made by the backgrounded command do not apply to subsequent commands.";

export { cancelCall };

export function sessionCwd(frame: ToolFrame, workspace: string): string {
  const id = frame.sessionId;
  if (id) {
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

export function persistCwd(workspace: string, sessionId: string, next: string, extraDirs: string[] = []): void {
  if (!sessionId) return;
  try {
    const root = real(workspace);
    cwdBySession.set(sessionId, mapCwd(root, undefined, real(next), extraDirs, root));
  } catch {
  }
}

export function resetSessionCwd(sessionId: string): void {
  if (sessionId) cwdBySession.delete(sessionId);
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

async function pump(stream: ReadableStream<Uint8Array> | undefined, into: { text: string }): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    into.text += decoder.decode(value, { stream: true });
  }
  into.text += decoder.decode();
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
): void {
  notify({
    v: 1,
    type: "notify",
    kind: "background",
    status: "exited",
    callId: frame.callId ?? "",
    sessionId: frame.sessionId,
    pid,
    exitCode: aborted ? 137 : exitCode,
    interrupted: aborted,
    output: output.slice(-8000),
  });
}

function watchBackground(
  proc: Bun.Subprocess,
  finished: Promise<unknown>,
  frame: ToolFrame,
  buffers: { stdout: { text: string }; stderr: { text: string } },
  notify: Send,
  remainingMs: number,
): void {
  const callId = frame.callId ?? "";
  const timer = setTimeout(() => killTree(proc.pid), remainingMs);
  proc.unref();
  void finished.then(async () => {
    clearTimeout(timer);
    const aborted = finishJob(callId);
    const code = typeof proc.exitCode === "number" ? proc.exitCode : await proc.exited;
    notifyExit(
      notify,
      frame,
      proc.pid,
      aborted ? 137 : code,
      aborted,
      `${buffers.stdout.text}${buffers.stderr.text ? `\n${buffers.stderr.text}` : ""}`,
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
  const command = rewriteRemoteText(asString(input.command), workspace, frame.tuiRoot);
  const cwd = sessionCwd(frame, workspace);
  const callId = frame.callId ?? "";
  const sessionId = frame.sessionId || "";
  const sandbox = asBool(input.dangerouslyDisableSandbox) === true ? { dangerouslyDisableSandbox: true } : {};

  if (wasCancelled(callId)) return abortedResult();
  const env = await withDirenv(cwd, process.env);
  if (wasCancelled(callId)) return abortedResult();
  if (asBool(input.run_in_background)) {
    return background(frame, command, cwd, env, notify, clampTimeout(asNumber(input.timeout), BG_TIMEOUT_DEFAULT, 1, BG_TIMEOUT_MAX));
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
  registerJob(callId, sessionId, () => killTree(proc.pid));
  if (wasCancelled(callId)) {
    killTree(proc.pid);
    finishJob(callId);
    await Bun.file(pwdFile).delete().catch(() => {});
    return abortedResult();
  }

  const stdout = { text: "" };
  const stderrBuf = { text: "" };
  const finished = Promise.all([pump(proc.stdout, stdout), pump(proc.stderr, stderrBuf), proc.exited]);
  const raced = await waitWithTimeout(timeoutMs, finished);

  if (raced.timedOut) {
    if (wasCancelled(callId)) return abortRunning(proc, callId, pwdFile, stdout.text, stderrBuf.text);
    await waitWithTimeout(DRAIN_AFTER_TIMEOUT_MS, finished);
    if (wasCancelled(callId)) return abortRunning(proc, callId, pwdFile, stdout.text, stderrBuf.text);
    watchBackground(proc, finished, frame, { stdout, stderr: stderrBuf }, notify, BG_TIMEOUT_DEFAULT);
    await Bun.file(pwdFile).delete().catch(() => {});
    return {
      stdout: clip(stdout.text.trimEnd()),
      stderr: clip(stderrBuf.text.trimEnd()),
      interrupted: false,
      backgroundTaskId: String(proc.pid),
      timedOutAfterMs: timeoutMs,
      ...backgroundCwdHint(command, cwd),
      ...sandbox,
    };
  }

  const aborted = finishJob(callId);
  const nextCwd = (await Bun.file(pwdFile).text().catch(() => "")).trim();
  if (nextCwd) persistCwd(workspace, sessionId, nextCwd, extraDirs);
  await Bun.file(pwdFile).delete().catch(() => {});
  const code = raced.value[2];
  let stderr = clip(stderrBuf.text);
  if (aborted) stderr = append(stderr, "Command was aborted before completion");
  else if (code !== 0) stderr = append(stderr, `Exit code ${code}`);
  return {
    stdout: clip(stdout.text.trimEnd()),
    stderr: stderr.trimEnd(),
    interrupted: aborted,
    ...sandbox,
  };
}

function background(
  frame: ToolFrame,
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  notify: Send,
  timeoutMs: number,
): BashOutput {
  const output = join(tmpdir(), `cc-mods-bg-${process.pid}-${Date.now()}.log`);
  mkdirSync(tmpdir(), { recursive: true });
  const proc = Bun.spawn(["bash", "-c", `exec >>"$OUT" 2>&1\n${command}`], {
    cwd,
    env: spawnEnv({ ...env, OUT: output }),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  const callId = frame.callId ?? "";
  const sessionId = frame.sessionId || "";
  const id = String(proc.pid);
  registerJob(callId, sessionId, () => killTree(proc.pid));
  const timer = setTimeout(() => killTree(proc.pid), timeoutMs);
  proc.unref();
  void proc.exited.then(async (exitCode) => {
    clearTimeout(timer);
    const aborted = finishJob(callId);
    const tail = await Bun.file(output).text().catch(() => "");
    notifyExit(notify, frame, proc.pid, aborted ? 137 : exitCode, aborted, tail);
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
