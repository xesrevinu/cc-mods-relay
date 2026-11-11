import type { EngineTerminal, TerminalExitEvent, TerminalSpawn } from "./terminal-backend.js";

const COLS = 120;
const ROWS = 40;

/** Bun 1.4+ `spawn({ terminal })` PTY. No node-pty, no script(1). */
export function createBunPtySpawn(): TerminalSpawn {
  return (file, args, options) => {
    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(event: TerminalExitEvent) => void>();
    const decoder = new TextDecoder();
    let exited = false;

    const proc = Bun.spawn([file, ...args], {
      cwd: options.cwd,
      env: options.env,
      terminal: {
        cols: options.cols ?? COLS,
        rows: options.rows ?? ROWS,
        name: options.name ?? "xterm-256color",
        data(_terminal, data) {
          const text = typeof data === "string" ? data : decoder.decode(data);
          for (const listener of dataListeners) listener(text);
        },
      },
    });

    void proc.exited.then((exitCode) => {
      exited = true;
      const event = { exitCode: exitCode ?? 0 };
      for (const listener of exitListeners) listener(event);
      try {
        proc.terminal?.close();
      } catch {
        /* already closed */
      }
    });

    const handle: EngineTerminal = {
      pid: proc.pid,
      write(data: string) {
        if (!exited) proc.terminal?.write(data);
      },
      onData(listener) {
        dataListeners.add(listener);
        return { dispose: () => { dataListeners.delete(listener); } };
      },
      onExit(listener) {
        exitListeners.add(listener);
        return { dispose: () => { exitListeners.delete(listener); } };
      },
      kill() {
        proc.kill();
      },
      resize(cols, rows) {
        proc.terminal?.resize(cols, rows);
      },
    };
    return handle;
  };
}
