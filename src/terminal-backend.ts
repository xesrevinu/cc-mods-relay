export type TerminalExitEvent = { exitCode: number; signal?: number };

export type TerminalDisposable = { dispose(): void };

export type EngineTerminal = {
  pid: number;
  write(data: string): void;
  onData(listener: (data: string) => void): TerminalDisposable;
  onExit(listener: (event: TerminalExitEvent) => void): TerminalDisposable;
  kill(signal?: string): void;
  resize(cols: number, rows: number): void;
};

export type TerminalSpawnOptions = {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: { [key: string]: string };
};

export type TerminalSpawn = (
  file: string,
  args: string[] | readonly string[],
  options: TerminalSpawnOptions,
) => EngineTerminal;

export type TerminalBackendName = "herdr" | "bun-pty";

export function resolveTerminalBackendName(
  env: NodeJS.ProcessEnv = process.env,
): TerminalBackendName {
  const raw = (env.CLAUDE_TUI_BACKEND || "herdr").trim().toLowerCase();
  if (raw === "node-pty" || raw === "nodepty" || raw === "pty" || raw === "bun-pty" || raw === "bun") {
    return "bun-pty";
  }
  return "herdr";
}
