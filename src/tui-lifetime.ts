/** True if `kill(pid, 0)` succeeds. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kill a process and, on POSIX, its process group. Never throw. */
export function signalPidTree(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
    } catch {
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
  }
}

const reapers = new Set<() => void>();

/** Register a last-ditch TUI killer for process `exit`. Returns unregister. */
export function registerTuiReaper(kill: () => void): () => void {
  reapers.add(kill);
  return () => {
    reapers.delete(kill);
  };
}

export function reapAllTuis(): void {
  const fns = [...reapers];
  reapers.clear();
  for (const kill of fns) {
    try {
      kill();
    } catch {
    }
  }
}

let hooked = false;

/** Sync SIGKILL of remaining TUIs when the agent process actually exits. */
export function installTuiExitHooks(): void {
  if (hooked) return;
  hooked = true;
  process.on("exit", () => reapAllTuis());
}
