import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const FORBIDDEN_BILLING_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_AGENT_SDK_CLIENT_APP",
] as const;

import type {
  TerminalDisposable,
  TerminalExitEvent,
  EngineTerminal,
  TerminalSpawn,
  TerminalSpawnOptions,
} from "./terminal-backend.js";

export type HerdrCliRunner = (argv: string[]) => { stdout: string; stderr: string; status: number | null };

export type HerdrSpawnFactoryOptions = {
  herdrSession?: string;
  herdrBin?: string;
  runCli?: HerdrCliRunner;
  pollMs?: number;
  readyTimeoutMs?: number;
};

export function resolveHerdrBin(env: NodeJS.ProcessEnv = process.env, explicit?: string): string {
  const fromOpt = explicit?.trim();
  if (fromOpt) return fromOpt;
  const fromEnv = env.CLAUDE_TUI_HERDR_BIN?.trim();
  if (fromEnv) return fromEnv;
  return "herdr";
}

export function herdrCliEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  const herdrHome = env.CLAUDE_TUI_HERDR_HOME?.trim();
  if (herdrHome) out.HOME = herdrHome;
  return out;
}

function defaultRunCli(argv: string[]): { stdout: string; stderr: string; status: number | null } {
  const res = spawnSync(argv[0]!, argv.slice(1), {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: herdrCliEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = res.stderr?.toString() ?? "";
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    const hint =
      code === "ENOENT"
        ? `herdr executable not found: ${argv[0]}. Add it to PATH or set CLAUDE_TUI_HERDR_BIN to an absolute path.`
        : res.error.message;
    stderr = stderr ? `${hint}\n${stderr}` : hint;
  } else if (res.status == null && res.signal) {
    const hint = `herdr killed by signal ${res.signal}`;
    stderr = stderr ? `${hint}\n${stderr}` : hint;
  }
  return {
    stdout: res.stdout?.toString() ?? "",
    stderr,
    status: res.status,
  };
}

function parseJsonLine(raw: string): unknown {
  const line = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith("{"));
  if (!line) throw new Error(`herdr-backend: expected JSON from herdr, got: ${raw.slice(0, 300)}`);
  return JSON.parse(line);
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function buildLaunchScript(cmd: string, env: Record<string, string | undefined>, scriptDir: string): string {
  const lines: string[] = ["#!/bin/sh", `rm -rf -- ${shellQuote(scriptDir)}`];
  const assigns: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if ((FORBIDDEN_BILLING_VARS as readonly string[]).includes(k)) continue;
    if (!ENV_KEY.test(k)) continue;
    assigns.push(`${k}=${shellQuote(v)}`);
  }
  const envCmd = assigns.length > 0 ? `env -i ${assigns.join(" ")}` : "env -i";
  lines.push(`exec ${envCmd} /bin/sh -c ${shellQuote(cmd)}`);
  lines.push("");
  return lines.join("\n");
}

function keyForControlByte(ch: string): string[] | null {
  if (ch === "\r" || ch === "\n") return ["enter"];
  if (ch === "\x1b") return ["esc"];
  if (ch === "\x03") return ["ctrl+c"];
  if (ch === "\x15") return ["ctrl+u"];
  return null;
}

export function tuiInputReady(snap: string): boolean {
  if (
    snap.includes("Quick safety check") ||
    snap.includes("Do you want to use this API key") ||
    snap.includes("Yes, I accept") ||
    snap.includes("Let's get started") ||
    snap.includes("Press Enter to continue")
  ) {
    return false;
  }
  return snap.includes("for shortcuts") || snap.includes("shift+tab to cycle") || snap.includes("auto mode on");
}

export function createHerdrSpawn(factoryOpts: HerdrSpawnFactoryOptions = {}): TerminalSpawn {
  const herdrSession = factoryOpts.herdrSession || "default";
  const herdrBin = resolveHerdrBin(process.env, factoryOpts.herdrBin);
  const runCli = factoryOpts.runCli || defaultRunCli;
  const pollMs = factoryOpts.pollMs ?? 250;
  const readyFromEnv = Number(process.env.CLAUDE_TUI_READY_TIMEOUT_MS);
  const readyTimeoutMs = factoryOpts.readyTimeoutMs ?? (Number.isFinite(readyFromEnv) && readyFromEnv > 0 ? readyFromEnv : 30_000);

  const herdr = (...args: string[]) => {
    const argv = [herdrBin, "--session", herdrSession, ...args];
    const res = runCli(argv);
    if (res.status !== 0) {
      const err =
        (res.stderr || res.stdout || "").trim() ||
        (res.status == null
          ? `exit status null (executable missing or spawn failed: ${herdrBin})`
          : `exit ${res.status}`);
      throw new Error(`herdr-backend: herdr ${args.join(" ")} failed: ${err}`);
    }
    const raw = (res.stdout || res.stderr || "").trim();
    if (!raw) {
      return { id: `cli:${args[0] || "herdr"}`, result: { type: "ok" } };
    }
    return parseJsonLine(raw);
  };

  return (file: string, args: string[] | readonly string[], options: TerminalSpawnOptions): EngineTerminal => {
    const shellCmd =
      args.length >= 2 && (args[0] === "-c" || args[0] === "-lc")
        ? String(args[1])
        : `${file} ${args.join(" ")}`;
    const cwd = options.cwd || process.cwd();
    const env = options.env || {};

    const scriptDir = mkdtempSync(join(tmpdir(), "claude-tui-herdr-"));
    const scriptPath = join(scriptDir, "launch");
    writeFileSync(scriptPath, buildLaunchScript(shellCmd, env, scriptDir), { mode: 0o700 });

    let workspaceId = "";
    let tabId = "";
    let paneId = "";
    const closeOwnSurface = (): void => {
      if (workspaceId) {
        try {
          herdr("workspace", "close", workspaceId);
          return;
        } catch {
        }
      }
      if (tabId) {
        try {
          herdr("tab", "close", tabId);
        } catch {
        }
      }
    };
    try {
      const created = herdr(
        "workspace",
        "create",
        "--cwd",
        cwd,
        "--label",
        "claude-tui",
        "--no-focus",
        // herdr `pane run` types into the pane shell. Mini's login zsh hits an
        // interactive compinit prompt; /bin/sh does not.
        "--env",
        "SHELL=/bin/sh",
      ) as {
        result?: {
          workspace?: { workspace_id?: string };
          tab?: { tab_id?: string };
          root_pane?: { pane_id?: string };
        };
      };
      workspaceId = created.result?.workspace?.workspace_id || "";
      tabId = created.result?.tab?.tab_id || "";
      paneId = created.result?.root_pane?.pane_id || "";
      if (!workspaceId || !tabId || !paneId) {
        throw new Error(`herdr-backend: workspace create missing ids: ${JSON.stringify(created)}`);
      }

      herdr("pane", "run", paneId, "/bin/sh", scriptPath);

      const readReady = (): string => {
        const res = runCli([herdrBin, "--session", herdrSession, "pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "80"]);
        return (res.stdout || res.stderr || "").replace(/\s+/g, " ");
      };
      const deadline = Date.now() + readyTimeoutMs;
      let dismissedTheme = false;
      let acceptedApiKey = false;
      let acceptedBypass = false;
      let lastEnter = 0;
      let lastSnap = "";
      while (Date.now() < deadline) {
        lastSnap = readReady();
        if (tuiInputReady(lastSnap)) break;
        if (!dismissedTheme && (lastSnap.includes("Let's get started") || lastSnap.includes("Choose the text style"))) {
          try { herdr("pane", "send-keys", paneId, "enter"); } catch { /* pane gone */ }
          dismissedTheme = true;
        } else if (!acceptedApiKey && lastSnap.includes("Do you want to use this API key")) {
          try {
            herdr("pane", "send-keys", paneId, "up");
            herdr("pane", "send-keys", paneId, "enter");
          } catch { /* pane gone */ }
          acceptedApiKey = true;
        } else if (
          (lastSnap.includes("I trust this folder") || lastSnap.includes("Quick safety check")) &&
          Date.now() - lastEnter > 1500
        ) {
          try { herdr("pane", "send-keys", paneId, "enter"); } catch { /* pane gone */ }
          lastEnter = Date.now();
        } else if (!acceptedBypass && lastSnap.includes("Yes, I accept")) {
          try {
            herdr("pane", "send-keys", paneId, "down");
            herdr("pane", "send-keys", paneId, "enter");
          } catch { /* pane gone */ }
          acceptedBypass = true;
        } else if (lastSnap.includes("Press Enter to continue") && Date.now() - lastEnter > 1500) {
          try { herdr("pane", "send-keys", paneId, "enter"); } catch { /* pane gone */ }
          lastEnter = Date.now();
        }
        Bun.sleepSync(250);
      }
      if (!tuiInputReady(lastSnap)) {
        throw new Error(
          `herdr-backend: timed out waiting for TUI input-ready in ${paneId} after ${readyTimeoutMs}ms: ${lastSnap.slice(-400) || "empty pane"}`,
        );
      }
    } catch (err) {
      try {
        rmSync(scriptDir, { recursive: true, force: true });
      } catch {
      }
      closeOwnSurface();
      throw err;
    }

    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(event: TerminalExitEvent) => void>();
    let exited = false;
    let exitEvent: TerminalExitEvent = { exitCode: 0 };
    let killed = false;
    let lastRead = "";

    const readPane = (): string => {
      try {
        const res = runCli([herdrBin, "--session", herdrSession, "pane", "read", paneId, "--source", "recent", "--lines", "50"]);
        if (res.status !== 0) return lastRead;
        const out = (res.stdout || "").replace(/\s+$/, "");
        if (out.startsWith("{")) {
          try {
            const raw = JSON.parse(out.split(/\r?\n/).find((l) => l.startsWith("{")) || out) as {
              result?: { text?: string; content?: string; output?: string } | string;
            };
            const r = raw.result;
            if (typeof r === "string") return r;
            if (r && typeof r === "object") return r.text || r.content || r.output || out;
          } catch {
          }
        }
        return out;
      } catch {
        return lastRead;
      }
    };

    const poll = setInterval(() => {
      if (exited) return;
      const snap = readPane();
      if (snap && snap !== lastRead) {
        let delta = snap;
        if (snap.startsWith(lastRead)) delta = snap.slice(lastRead.length);
        lastRead = snap;
        if (delta) for (const l of dataListeners) l(delta);
      }
    }, pollMs);

    let seenClaude = false;
    const watch = setInterval(() => {
      if (exited) return;
      try {
        const info = herdr("pane", "process-info", "--pane", paneId) as {
          result?: { process_info?: { foreground_processes?: { name?: string; cmdline?: string }[] } };
        };
        const procs = info.result?.process_info?.foreground_processes || [];
        const hasClaude = procs.some(
          (p) => (p.name || "").includes("claude") || /\bclaude\b/.test(p.cmdline || ""),
        );
        if (hasClaude) seenClaude = true;
        else if (seenClaude) {
          clearInterval(watch);
          clearInterval(poll);
          markExit({ exitCode: 0 });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("pane_not_found")) {
          clearInterval(watch);
          clearInterval(poll);
          markExit({ exitCode: killed ? 1 : 0 });
        }
      }
    }, pollMs);

    function markExit(ev: TerminalExitEvent): void {
      if (exited) return;
      exited = true;
      exitEvent = ev;
      for (const l of exitListeners) l(ev);
    }

    const handle: EngineTerminal = {
      pid: process.pid,
      write(data: string): void {
        if (exited) return;
        if (data.length === 1) {
          const keys = keyForControlByte(data);
          if (keys) {
            try {
              herdr("pane", "send-keys", paneId, ...keys);
              return;
            } catch {
            }
          }
        }
        if (data === "\x03") {
          try {
            herdr("pane", "send-keys", paneId, "ctrl+c");
            return;
          } catch {
          }
        }
        herdr("pane", "send-text", paneId, data);
      },
      onData(listener: (data: string) => void): TerminalDisposable {
        dataListeners.add(listener);
        return {
          dispose() {
            dataListeners.delete(listener);
          },
        };
      },
      onExit(listener: (event: TerminalExitEvent) => void): TerminalDisposable {
        if (exited) {
          queueMicrotask(() => listener(exitEvent));
        }
        exitListeners.add(listener);
        return {
          dispose() {
            exitListeners.delete(listener);
          },
        };
      },
      kill(_signal?: string): void {
        if (exited) return;
        killed = true;
        closeOwnSurface();
        clearInterval(poll);
        clearInterval(watch);
        markExit({ exitCode: 1 });
      },
      resize(_cols: number, _rows: number): void {
      },
    };

    return handle;
  };
}
