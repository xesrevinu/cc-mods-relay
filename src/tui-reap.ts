import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pidAlive, signalPidTree } from "./tui-lifetime.js";
import { HERDR_WORKSPACE_LABEL } from "./herdr-names.js";

export type HerdrCliRunner = (argv: string[]) => { stdout: string; stderr: string; status: number | null };

const SAFE_ID = /^[A-Za-z0-9:._-]+$/;

export type TuiStamp = { workspaceId: string; paneId?: string; tabId?: string };

export type PsRow = { pid: number; ppid: number; command: string };

export function tuiStampRoot(session: string, root = tmpdir()): string {
  return join(root, "claude-tui", session);
}

export function stampWorkspace(session: string, stamp: TuiStamp, pid = process.pid, root = tmpdir()): void {
  if (!SAFE_ID.test(session) || !SAFE_ID.test(stamp.workspaceId) || !Number.isInteger(pid) || pid <= 1) return;
  const dir = join(tuiStampRoot(session, root), String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, stamp.workspaceId), `${JSON.stringify(stamp)}\n`);
}

export function unstampWorkspace(session: string, workspaceId: string, pid = process.pid, root = tmpdir()): void {
  if (!SAFE_ID.test(session) || !SAFE_ID.test(workspaceId)) return;
  try {
    rmSync(join(tuiStampRoot(session, root), String(pid), workspaceId));
  } catch {
  }
}

function listPidDirs(session: string, root: string): { pid: number; dir: string }[] {
  if (!SAFE_ID.test(session)) return [];
  let names: string[] = [];
  try {
    names = readdirSync(tuiStampRoot(session, root));
  } catch {
    return [];
  }
  return names
    .map((name) => ({ pid: Number(name), dir: join(tuiStampRoot(session, root), name) }))
    .filter((row) => Number.isInteger(row.pid) && row.pid > 1);
}

function readStamps(dir: string): TuiStamp[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: TuiStamp[] = [];
  for (const name of names) {
    if (!SAFE_ID.test(name)) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as TuiStamp;
      if (parsed.workspaceId && SAFE_ID.test(parsed.workspaceId)) out.push(parsed);
      else out.push({ workspaceId: name });
    } catch {
      out.push({ workspaceId: name });
    }
  }
  return out;
}

export function parsePs(text: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! });
  }
  return rows;
}

export function orphanPluginPids(rows: PsRow[], pluginDir: string, alive = pidAlive): number[] {
  const plugin = pluginDir.replace(/\/+$/, "");
  if (!plugin) return [];
  const out: number[] = [];
  for (const row of rows) {
    if (row.pid === process.pid) continue;
    const isClaude = /\bclaude\b/.test(row.command) && row.command.includes(`--plugin-dir ${plugin}`);
    const isWs = row.command.includes("ws-client.js") && row.command.includes(plugin);
    if (!isClaude && !isWs) continue;
    if (row.ppid <= 1 || !alive(row.ppid)) out.push(row.pid);
  }
  return out;
}

export function reapOrphanPluginProcesses(pluginDir: string): number[] {
  if (process.platform === "win32" || !pluginDir) return [];
  const res = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="], { stdout: "pipe", stderr: "pipe" });
  const pids = orphanPluginPids(parsePs(res.stdout.toString()), pluginDir);
  for (const pid of pids) signalPidTree(pid, "SIGKILL");
  return pids;
}

function jsonPayload(raw: { stdout: string; stderr: string }): unknown {
  const text = `${raw.stdout}\n${raw.stderr}`;
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

export function reapOrphanHerdrWorkspaces(opts: {
  herdrSession: string;
  runCli?: HerdrCliRunner;
  herdrBin?: string;
  stampRoot?: string;
  alive?: (pid: number) => boolean;
}): { closed: string[]; pids: number[] } {
  const session = opts.herdrSession;
  const root = opts.stampRoot ?? tmpdir();
  const alive = opts.alive ?? pidAlive;
  const herdrBin = opts.herdrBin?.trim() || process.env.CLAUDE_TUI_HERDR_BIN?.trim() || "herdr";
  const runCli = opts.runCli ?? ((argv: string[]) => {
    const res = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
    return {
      stdout: res.stdout.toString(),
      stderr: res.stderr.toString(),
      status: res.exitCode,
    };
  });
  const herdr = (...args: string[]) => runCli([herdrBin, "--session", session, ...args]);
  const liveIds = new Set<string>();
  const orphanStamps: TuiStamp[] = [];
  const staleDirs: string[] = [];

  for (const { pid, dir } of listPidDirs(session, root)) {
    const live = pid === process.pid || alive(pid);
    for (const stamp of readStamps(dir)) {
      if (live) liveIds.add(stamp.workspaceId);
      else orphanStamps.push(stamp);
    }
    if (!live) staleDirs.push(dir);
  }

  const listed = jsonPayload(herdr("workspace", "list")) as {
    result?: { workspaces?: { workspace_id?: string; label?: string }[] };
  } | null;
  const panes = jsonPayload(herdr("pane", "list")) as {
    result?: { panes?: { pane_id?: string; workspace_id?: string }[] };
  } | null;
  const paneByWs = new Map<string, string>();
  for (const pane of panes?.result?.panes ?? []) {
    if (pane.workspace_id && pane.pane_id) paneByWs.set(pane.workspace_id, pane.pane_id);
  }
  for (const ws of listed?.result?.workspaces ?? []) {
    const id = ws.workspace_id;
    if (!id || !SAFE_ID.test(id) || liveIds.has(id)) continue;
    if ((ws.label || "") !== HERDR_WORKSPACE_LABEL) continue;
    if (orphanStamps.some((s) => s.workspaceId === id)) continue;
    orphanStamps.push({ workspaceId: id, paneId: paneByWs.get(id) });
  }

  const pids = new Set<number>();
  for (const stamp of orphanStamps) {
    const paneId = stamp.paneId && SAFE_ID.test(stamp.paneId) ? stamp.paneId : paneByWs.get(stamp.workspaceId);
    if (!paneId) continue;
    const info = jsonPayload(herdr("pane", "process-info", "--pane", paneId));
    if (info) collectNumericPids(info, pids);
  }
  for (const pid of pids) signalPidTree(pid, "SIGKILL");

  const closed: string[] = [];
  for (const stamp of orphanStamps) {
    herdr("workspace", "close", stamp.workspaceId);
    closed.push(stamp.workspaceId);
  }
  for (const dir of staleDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  }
  return { closed, pids: [...pids] };
}

function collectNumericPids(info: unknown, into: Set<number>): void {
  if (typeof info === "number") {
    if (Number.isInteger(info) && info > 1 && info !== process.pid) into.add(info);
    return;
  }
  if (!info || typeof info !== "object") return;
  if (Array.isArray(info)) {
    for (const item of info) collectNumericPids(item, into);
    return;
  }
  for (const [key, value] of Object.entries(info as Record<string, unknown>)) {
    if (key === "pid" || key === "process_id" || key === "pgid") collectNumericPids(value, into);
    else if (value && typeof value === "object") collectNumericPids(value, into);
  }
}
