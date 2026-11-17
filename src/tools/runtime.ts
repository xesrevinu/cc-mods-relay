export type ToolFrame = {
  id?: string;
  callId?: string;
  sessionId?: string;
  cwd?: string;
  tuiRoot?: string;
  extraDirs?: string[];
  tool?: string;
  input?: Record<string, unknown>;
};

export type Send = (frame: Record<string, unknown>) => void;

export const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

export function abortedShellResult(stdout = "", stderr = ""): Record<string, unknown> {
  const extra = "Command was aborted before completion";
  const merged = stderr ? `${stderr.trimEnd()}\n${extra}` : extra;
  return { stdout, stderr: merged, interrupted: true };
}

export function clampTimeout(value: number | undefined, fallback: number, min: number, max: number): number {
  return Math.min(Math.max(value ?? fallback, min), max);
}

export function killTree(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export function ioMessage(path: string, error: unknown, missing: string): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return new Error(missing);
  if (code === "EACCES" || code === "EPERM") return new Error(`Permission denied: ${path}`);
  return error instanceof Error ? error : new Error(String(error));
}
