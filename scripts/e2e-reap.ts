/**
 * Live leftover check against the real SSH host.
 * Spawns a TUI on Mini, then simulates exits. Usage: bun scripts/e2e-reap.ts
 */
import { openRemote } from "../src/client.js";
import { configuredHost } from "../src/config.js";
import { REMOTE_PATH, rsh } from "../src/ssh.js";
import { AcpTestClient } from "../test/acp-client.js";
import { tuiInitializeParams } from "../test/harness.js";

const ARGS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const ONLY = new Set(
  (process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const HOST = ARGS[0] || (await configuredHost()) || "cc-remote";
const CWD = process.cwd();
const SETTLE_MS = Number(process.env.REAP_SETTLE_MS) || 15_000;

type Snap = {
  raw: string;
  herdr: string[];
  agents: string[];
  claudes: string[];
  ws: string[];
  workspaces: string[];
};

type Verdict = { name: string; ok: boolean; detail: string };

const verdicts: Verdict[] = [];

function liveEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CC_MODS_DEBUG: "1",
    CLAUDE_TUI_BACKEND: "herdr",
    FORK_GATE: "off",
  };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  delete env.CC_MODS_MOCK;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDE_CODE_SIMPLE;
  delete env.HOME;
  return env;
}

async function remote(cmd: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([...rsh(), "-T", HOST, `${REMOTE_PATH} ${cmd}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = (await proc.exited) ?? 1;
  return { code, out: `${stdout}${stderr}`.trim() };
}

function linesMatching(raw: string, re: RegExp): string[] {
  return raw
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => re.test(l) && !/\/usr\/bin\/login |zsh -c | rg /.test(l));
}

async function snap(): Promise<Snap> {
  const ps = await remote("ps -axo pid,ppid,etime,command");
  const raw = ps.out;
  const list = await remote("herdr --session cc-mods-relay workspace list");
  let workspaces: string[] = [];
  const start = list.out.indexOf("{");
  if (start >= 0) {
    try {
      const data = JSON.parse(list.out.slice(start)) as {
        result?: { workspaces?: { workspace_id?: string; label?: string }[] };
        error?: { code?: string };
      };
      workspaces = (data.result?.workspaces ?? []).map(
        (w) => `${w.workspace_id ?? "?"} ${w.label ?? ""}`.trim(),
      );
    } catch {
      workspaces = [list.out.slice(0, 200)];
    }
  } else if (/server_not_running/.test(list.out)) {
    workspaces = [];
  }
  return {
    raw,
    herdr: linesMatching(raw, /herdr --session cc-mods/),
    agents: linesMatching(raw, /bun .*\/.cc-mods-relay\/agent\.js/),
    claudes: linesMatching(raw, /claude --plugin-dir .*\/\.cc-mods-relay\/plugin/),
    ws: linesMatching(raw, /ws-client\.js/),
    workspaces,
  };
}

function fmt(snap: Snap, sessionId?: string): string {
  const sid = sessionId ? snap.claudes.filter((l) => l.includes(sessionId)) : snap.claudes;
  return [
    `  herdr servers: ${snap.herdr.length}`,
    ...snap.herdr.map((l) => `    ${l}`),
    `  agents: ${snap.agents.length}`,
    ...snap.agents.map((l) => `    ${l}`),
    `  claude TUI: ${sid.length}${sessionId ? ` (session ${sessionId})` : ""}`,
    ...sid.map((l) => `    ${l}`),
    `  ws-client: ${snap.ws.length}`,
    ...snap.ws.map((l) => `    ${l}`),
    `  herdr workspaces: ${snap.workspaces.length}`,
    ...snap.workspaces.map((l) => `    ${l}`),
  ].join("\n");
}

function sessionLeftovers(s: Snap, sessionId: string) {
  return {
    claudes: s.claudes.filter((l) => l.includes(sessionId)),
    agents: s.agents,
    ws: s.ws,
    workspaces: s.workspaces,
  };
}

async function pidsFor(re: RegExp): Promise<number[]> {
  const s = await snap();
  const rows = [...s.agents, ...s.claudes, ...s.ws, ...s.herdr].filter((l) => re.test(l));
  return rows.map((l) => Number(l.trim().split(/\s+/)[0])).filter((n) => n > 1);
}

async function forceClean(): Promise<void> {
  const s = await snap();
  const pids = [...s.agents, ...s.claudes, ...s.ws]
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => n > 1);
  for (const id of s.workspaces) {
    const wid = id.split(/\s+/)[0];
    if (wid && wid !== "?") await remote(`herdr --session cc-mods-relay workspace close ${wid}`);
  }
  if (pids.length) await remote(`kill -KILL ${pids.join(" ")} || true`);
  await Bun.sleep(400);
}

async function waitFor(label: string, pred: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await Bun.sleep(250);
  }
  throw new Error(`timeout waiting for ${label}`);
}

type Handle = {
  client: AcpTestClient;
  opened: Awaited<ReturnType<typeof openRemote>>;
  sessionId: string;
};

async function spawnSession(): Promise<Handle> {
  const opened = await openRemote(HOST, { cwd: CWD, env: liveEnv(), inheritErr: true });
  const client = AcpTestClient.fromNode(opened.child);
  try {
    await client.request("initialize", tuiInitializeParams(["Read"]), 45_000);
    const session = await client.request<{ sessionId: string }>(
      "session/new",
      { cwd: CWD, mcpServers: [] },
      90_000,
    );
    await waitFor("remote TUI", async () => {
      const s = await snap();
      return s.claudes.some((l) => l.includes(session.sessionId)) && s.agents.length > 0;
    }, 30_000);
    return { client, opened, sessionId: session.sessionId };
  } catch (err) {
    await client.stop();
    opened.relay.stop();
    throw err;
  }
}

async function settle(): Promise<Snap> {
  const start = Date.now();
  let last: Snap = await snap();
  while (Date.now() - start < SETTLE_MS) {
    const agents = last.agents.length;
    const claudes = last.claudes.length;
    const ws = last.ws.length;
    const workspaces = last.workspaces.length;
    console.error(
      `[t+${String(Date.now() - start).padStart(5)}ms] agents=${agents} claude=${claudes} ws-client=${ws} workspaces=${workspaces}`,
    );
    if (agents === 0 && claudes === 0 && ws === 0) break;
    await Bun.sleep(1_000);
    last = await snap();
  }
  return last;
}

function record(name: string, ok: boolean, detail: string): void {
  verdicts.push({ name, ok, detail });
  console.error(`[${ok ? "PASS" : "FAIL"}] ${name}: ${detail}`);
}

async function scenario(
  name: string,
  run: (h: Handle) => Promise<void>,
  check: (h: Handle, after: Snap) => { ok: boolean; detail: string },
): Promise<void> {
  if (ONLY.size && ![...ONLY].some((k) => name.toLowerCase().includes(k))) {
    console.error(`[skip] ${name}`);
    return;
  }
  console.error(`\n======== ${name} ========`);
  await forceClean();
  const h = await spawnSession();
  const during = await snap();
  console.error(`[during]\n${fmt(during, h.sessionId)}`);
  if (!during.claudes.some((l) => l.includes(h.sessionId))) {
    record(name, false, "TUI never appeared on Mini");
    await h.client.stop();
    h.opened.relay.stop();
    return;
  }
  try {
    await run(h);
  } catch (err) {
    console.error(`[${name}] interrupt: ${err instanceof Error ? err.message : err}`);
  }
  const after = await settle();
  console.error(`[after]\n${fmt(after, h.sessionId)}`);
  try {
    record(name, check(h, after).ok, check(h, after).detail);
  } finally {
    try {
      await h.client.stop();
    } catch {
    }
    h.opened.relay.stop();
    await forceClean();
  }
}

function noTui(after: Snap, sessionId: string): boolean {
  return sessionLeftovers(after, sessionId).claudes.length === 0;
}

async function main(): Promise<void> {
  console.error(`[reap] host=${HOST} cwd=${CWD}`);
  const baseline = await snap();
  console.error(`[baseline]\n${fmt(baseline)}`);
  if (baseline.claudes.length || baseline.ws.length || baseline.agents.length) {
    console.error("[reap] cleaning leftover cc-mods processes before start");
    await forceClean();
  }

  await scenario(
    "session/close then SIGTERM",
    async (h) => {
      await h.client.request("session/close", { sessionId: h.sessionId }, 20_000);
      const mid = await settle();
      console.error(`[after session/close]\n${fmt(mid, h.sessionId)}`);
      if (!noTui(mid, h.sessionId)) {
        throw new Error("TUI still alive after session/close");
      }
      await h.client.stop();
    },
    (h, after) => {
      const tui = noTui(after, h.sessionId);
      const agentGone = after.agents.length === 0;
      const ok = tui && agentGone && after.workspaces.length === 0 && after.ws.length === 0;
      return {
        ok,
        detail: `tuiGone=${tui} agentGone=${agentGone} workspaces=${after.workspaces.length} ws-client=${after.ws.length} herdrDaemon=${after.herdr.length}`,
      };
    },
  );

  await scenario(
    "local SIGTERM (Ctrl-C, no session/close)",
    async (h) => {
      h.opened.child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => h.opened.child.once("exit", () => resolve())),
        Bun.sleep(8_000),
      ]);
    },
    (h, after) => {
      const tui = noTui(after, h.sessionId);
      const agentGone = after.agents.length === 0;
      const ok = tui && agentGone && after.workspaces.length === 0 && after.ws.length === 0;
      return {
        ok,
        detail: `tuiGone=${tui} agentGone=${agentGone} workspaces=${after.workspaces.length} ws-client=${after.ws.length} herdrDaemon=${after.herdr.length}`,
      };
    },
  );

  await scenario(
    "local SIGKILL ssh (hard client death → sshd SIGHUP)",
    async (h) => {
      h.opened.child.kill("SIGKILL");
      await Promise.race([
        new Promise<void>((resolve) => h.opened.child.once("exit", () => resolve())),
        Bun.sleep(2_000),
      ]);
    },
    (h, after) => {
      const tui = noTui(after, h.sessionId);
      const agentGone = after.agents.length === 0;
      const ok = tui && agentGone && after.workspaces.length === 0 && after.ws.length === 0;
      return {
        ok,
        detail: `tuiGone=${tui} agentGone=${agentGone} workspaces=${after.workspaces.length} ws-client=${after.ws.length} herdrDaemon=${after.herdr.length}`,
      };
    },
  );

  await scenario(
    "remote SIGHUP on bun agent",
    async (h) => {
      const agents = await pidsFor(/bun .*\/.cc-mods-relay\/agent\.js/);
      if (!agents.length) throw new Error("no remote agent pid");
      console.error(`[reap] kill -HUP ${agents.join(" ")}`);
      await remote(`kill -HUP ${agents.join(" ")}`);
      await Promise.race([
        new Promise<void>((resolve) => h.opened.child.once("exit", () => resolve())),
        Bun.sleep(8_000),
      ]);
    },
    (h, after) => {
      const tui = noTui(after, h.sessionId);
      const agentGone = after.agents.length === 0;
      const ok = tui && agentGone && after.workspaces.length === 0 && after.ws.length === 0;
      return {
        ok,
        detail: `tuiGone=${tui} agentGone=${agentGone} workspaces=${after.workspaces.length} ws-client=${after.ws.length} herdrDaemon=${after.herdr.length}`,
      };
    },
  );

  await scenario(
    "remote SIGKILL on bun agent (hooks cannot run)",
    async (h) => {
      const agents = await pidsFor(/bun .*\/.cc-mods-relay\/agent\.js/);
      if (!agents.length) throw new Error("no remote agent pid");
      console.error(`[reap] kill -KILL ${agents.join(" ")}`);
      await remote(`kill -KILL ${agents.join(" ")}`);
      await Promise.race([
        new Promise<void>((resolve) => h.opened.child.once("exit", () => resolve())),
        Bun.sleep(8_000),
      ]);
    },
    (h, after) => {
      const tui = noTui(after, h.sessionId);
      const agentGone = after.agents.length === 0;
      // Expected: TUI/workspaces leak because reapers never run.
      const leaked = !tui || after.workspaces.length > 0;
      return {
        ok: agentGone && leaked,
        detail: `expected leak: tuiGone=${tui} agentGone=${agentGone} workspaces=${after.workspaces.length} herdrDaemon=${after.herdr.length}`,
      };
    },
  );

  if (!ONLY.size || [...ONLY].some((k) => ["reap", "next"].some((n) => k.toLowerCase().includes(n)))) {
    console.error("\n======== next start reaps SIGKILL orphans ========");
    await forceClean();
    const leaked = await spawnSession();
    const agents = await pidsFor(/bun .*\/.cc-mods-relay\/agent\.js/);
    console.error(`[reap] kill -KILL ${agents.join(" ")} (leave TUI)`);
    if (agents.length) await remote(`kill -KILL ${agents.join(" ")}`);
    await Promise.race([
      new Promise<void>((resolve) => leaked.opened.child.once("exit", () => resolve())),
      Bun.sleep(8_000),
    ]);
    try {
      await leaked.client.stop();
    } catch {
    }
    leaked.opened.relay.stop();
    const mid = await snap();
    console.error(`[leaked]\n${fmt(mid, leaked.sessionId)}`);
    const didLeak = !noTui(mid, leaked.sessionId) || mid.workspaces.length > 0;
    if (!didLeak) {
      record("next start reaps SIGKILL orphans", false, "SIGKILL did not leak, so reap-on-start was not exercised");
    } else {
      const next = await spawnSession();
      const after = await snap();
      console.error(`[after next session/new]\n${fmt(after)}`);
      const oldGone = noTui(after, leaked.sessionId);
      const newLive = after.claudes.some((l) => l.includes(next.sessionId));
      record(
        "next start reaps SIGKILL orphans",
        oldGone && newLive,
        `oldGone=${oldGone} newLive=${newLive} workspaces=${after.workspaces.length}`,
      );
      try {
        await next.client.request("session/close", { sessionId: next.sessionId }, 20_000);
      } catch {
      }
      await next.client.stop();
      next.opened.relay.stop();
    }
  }

  console.error("\n======== summary ========");
  for (const v of verdicts) {
    console.error(`${v.ok ? "PASS" : "FAIL"}  ${v.name}  ${v.detail}`);
  }
  const failed = verdicts.filter((v) => !v.ok);
  await forceClean();
  const end = await snap();
  console.error(`[final]\n${fmt(end)}`);
  if (end.herdr.length) {
    await remote("herdr --session cc-mods-relay server stop || true");
  }
  if (failed.length) process.exitCode = 1;
}

await main();
