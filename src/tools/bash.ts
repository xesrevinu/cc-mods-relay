import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cancelCall, finishJob, registerJob, wasCancelled } from "./jobs.js";
import { asBool, asNumber, asString, inside } from "./paths.js";

type ToolFrame = { callId?: string; sessionId?: string; cwd?: string; tool?: string };

type Send = (frame: Record<string, unknown>) => void;

const MAX_OUTPUT = 30_000;
const cwdBySession = new Map<string, string>();

export { cancelCall };

function sessionCwd(frame: ToolFrame, workspace: string): string {
  const id = frame.sessionId || "";
  return cwdBySession.get(id) || frame.cwd || workspace;
}

function persistCwd(workspace: string, sessionId: string, next: string): void {
  try {
    cwdBySession.set(sessionId, inside(workspace, next));
  } catch {
  }
}

function killTree(pid: number): void {
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { } }
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

function abortedResult(stdout = "", stderr = ""): Record<string, unknown> {
  return {
    stdout: clip(stdout.trimEnd()),
    stderr: clip(append(stderr, "Command was aborted before completion")).trimEnd(),
    interrupted: true,
  };
}

export async function bashTool(
  workspace: string,
  frame: ToolFrame,
  input: Record<string, unknown>,
  notify: Send,
): Promise<Record<string, unknown>> {
  const command = asString(input.command);
  const cwd = sessionCwd(frame, workspace);
  const callId = frame.callId ?? "";
  const sessionId = frame.sessionId || "";

  if (wasCancelled(callId)) return abortedResult();
  if (asBool(input.run_in_background)) return background(frame, command, cwd, notify);

  const pwdFile = join(tmpdir(), `cc-mods-pwd-${process.pid}-${callId || Date.now()}`);
  const argv = shellArgv(frame.tool || "Bash", command);
  const timeoutMs = Math.min(Math.max(asNumber(input.timeout) ?? 120_000, 1), 600_000);
  const proc = Bun.spawn(argv, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
    env: { ...process.env, __CC_PWD: pwdFile },
  });
  registerJob(callId, sessionId, () => killTree(proc.pid));
  if (wasCancelled(callId)) {
    killTree(proc.pid);
    finishJob(callId);
    await Bun.file(pwdFile).delete().catch(() => {});
    return abortedResult();
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killTree(proc.pid); }, timeoutMs);
  let stdoutRaw = "";
  let stderrRaw = "";
  let code: number | null = null;
  try {
    [stdoutRaw, stderrRaw, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } catch (error) {
    killTree(proc.pid);
    const aborted = finishJob(callId);
    await Bun.file(pwdFile).delete().catch(() => {});
    if (aborted) return abortedResult();
    throw error;
  }
  clearTimeout(timer);
  const aborted = finishJob(callId);
  const nextCwd = (await Bun.file(pwdFile).text().catch(() => "")).trim();
  if (nextCwd) persistCwd(workspace, sessionId, nextCwd);
  await Bun.file(pwdFile).delete().catch(() => {});

  let stderr = clip(stderrRaw);
  if (aborted) stderr = append(stderr, "Command was aborted before completion");
  else if (timedOut) stderr = append(stderr, `Command timed out after ${timeoutMs}ms`);
  else if (code !== 0) stderr = append(stderr, `Exit code ${code}`);
  return {
    stdout: clip(stdoutRaw.trimEnd()),
    stderr: stderr.trimEnd(),
    interrupted: aborted || timedOut,
  };
}

function background(frame: ToolFrame, command: string, cwd: string, notify: Send): Record<string, unknown> {
  const output = join(tmpdir(), `cc-mods-bg-${process.pid}-${Date.now()}.log`);
  mkdirSync(tmpdir(), { recursive: true });
  const proc = Bun.spawn(["bash", "-c", `exec >>"$OUT" 2>&1\n${command}`], {
    cwd,
    env: { ...process.env, OUT: output },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  const callId = frame.callId ?? "";
  const sessionId = frame.sessionId || "";
  const id = String(proc.pid);
  registerJob(callId, sessionId, () => killTree(proc.pid));
  proc.unref();
  void proc.exited.then(async (exitCode) => {
    const aborted = finishJob(callId);
    const tail = await Bun.file(output).text().catch(() => "");
    notify({
      v: 1,
      type: "notify",
      kind: "background",
      status: "exited",
      callId,
      sessionId: frame.sessionId,
      pid: proc.pid,
      exitCode: aborted ? 137 : exitCode,
      interrupted: aborted,
      outputPath: output,
      output: tail.slice(-8000),
    });
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
    backgroundOutputPath: output,
  };
}
