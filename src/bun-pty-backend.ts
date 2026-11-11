import type { EngineTerminal, TerminalExitEvent, TerminalSpawn } from "./terminal-backend.js";
import { registerTuiReaper, signalPidTree } from "./tui-lifetime.js";

const COLS = 120;
const ROWS = 40;
const KILL_ESCALATE_MS = 500;

/** Bun 1.4+ `spawn({ terminal })` PTY. No node-pty, no script(1). */
export function createBunPtySpawn(): TerminalSpawn {
  return (file, args, options) => {
    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(event: TerminalExitEvent) => void>();
    const decoder = new TextDecoder();
    let exited = false;
    let escalate: ReturnType<typeof setTimeout> | undefined;

    const proc = Bun.spawn([file, ...args], {
      cwd: options.cwd,
      env: options.env,
      ...(process.platform !== "win32" ? { detached: true } : {}),
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

    const reap = (signal: NodeJS.Signals): void => {
      try {
        proc.kill(signal);
      } catch {
      }
      signalPidTree(proc.pid, signal);
      if (signal === "SIGKILL") {
        try {
          proc.terminal?.close();
        } catch {
        }
      }
    };

    const unregister = registerTuiReaper(() => reap("SIGKILL"));

    const markExit = (exitCode: number): void => {
      if (exited) return;
      exited = true;
      if (escalate !== undefined) {
        clearTimeout(escalate);
        escalate = undefined;
      }
      unregister();
      const event: TerminalExitEvent = { exitCode };
      for (const listener of exitListeners) listener(event);
      try {
        proc.terminal?.close();
      } catch {
      }
    };

    void proc.exited.then((exitCode) => markExit(exitCode ?? 0));

    const handle: EngineTerminal = {
      pid: proc.pid,
      write(data: string) {
        if (!exited) proc.terminal?.write(data);
      },
      onData(listener) {
        dataListeners.add(listener);
        return {
          dispose: () => {
            dataListeners.delete(listener);
          },
        };
      },
      onExit(listener) {
        if (exited) queueMicrotask(() => listener({ exitCode: 0 }));
        exitListeners.add(listener);
        return {
          dispose: () => {
            exitListeners.delete(listener);
          },
        };
      },
      kill(signal?: string) {
        if (exited) {
          try {
            proc.terminal?.close();
          } catch {
          }
          return;
        }
        const first = signal === "SIGKILL" || signal === "SIGTERM" ? (signal as NodeJS.Signals) : "SIGTERM";
        reap(first);
        if (first === "SIGKILL") return;
        escalate = setTimeout(() => {
          escalate = undefined;
          if (!exited) reap("SIGKILL");
        }, KILL_ESCALATE_MS);
      },
      resize(cols, rows) {
        proc.terminal?.resize(cols, rows);
      },
    };
    return handle;
  };
}
