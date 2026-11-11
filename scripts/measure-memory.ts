/**
 * Production-path memory: host JSONL stays on disk; the agent tails new bytes;
 * Mods carries live ACP events so the transcript is not kept in RAM.
 */
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredHost } from "../src/config.js";
import { rsh } from "../src/ssh.js";

type Row = { name: string; rssKb?: number; heapMb?: number; ms?: number; bytes?: number; note?: string };

const root = join(import.meta.dir, "..");

async function bunEval(source: string): Promise<Record<string, number>> {
  const child = Bun.spawn(["bun", "-e", source], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = (await new Response(child.stdout).text()).trim();
  const err = (await new Response(child.stderr).text()).trim();
  const code = await child.exited;
  if (code !== 0) throw new Error(err || out || `exit ${code}`);
  return JSON.parse(out.split("\n").at(-1)!) as Record<string, number>;
}

function snapshotExpr(extra = ""): string {
  const fields = extra ? `{rssKb,heapMb,${extra}}` : `{rssKb,heapMb}`;
  return `const rssKb=Number(Bun.spawnSync(["ps","-o","rss=","-p",String(process.pid)]).stdout.toString()); const heapMb=Math.round(process.memoryUsage().heapUsed/1024/1024*10)/10; process.stdout.write(JSON.stringify(${fields}))`;
}

function line(i: number): string {
  return JSON.stringify({
    uuid: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    type: i % 2 === 0 ? "user" : "assistant",
    timestamp: "2026-11-12T00:00:00.000Z",
    message: {
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `turn ${i} ${"x".repeat(200)}` }],
    },
  });
}

function writeJsonl(path: string, n: number): number {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(line(i));
  writeFileSync(path, `${parts.join("\n")}\n`);
  return statSync(path).size;
}

async function hostJsonl(): Promise<Row | undefined> {
  const host = await configuredHost();
  if (!host) return undefined;
  const remote = `python3 - <<'PY'
import os, glob
root = os.path.expanduser("~/.claude/projects")
files = glob.glob(root + "/**/*.jsonl", recursive=True) if os.path.isdir(root) else []
sizes = sorted((os.path.getsize(p), p) for p in files)
total = sum(s for s,_ in sizes)
n = len(sizes)
print(n)
print(total)
print(sizes[-1][0] if sizes else 0)
print(round(total/n) if n else 0)
PY`;
  const proc = Bun.spawn([...rsh(), "-T", host, remote], { stdout: "pipe", stderr: "pipe" });
  const text = (await new Response(proc.stdout).text()).trim();
  const err = (await new Response(proc.stderr).text()).trim();
  const code = await proc.exited;
  if (code !== 0) return { name: "SSH host session JSONL", note: err || `ssh exit ${code}` };
  const [count, total, largest, mean] = text.split("\n").map(Number);
  return {
    name: "SSH host session JSONL",
    bytes: total,
    note: `${count} files, mean ${Math.round(mean / 1024)} KB, largest ${Math.round(largest / 1024)} KB`,
  };
}

function fmt(row: Row): string {
  const bits = [row.name];
  if (row.rssKb != null) bits.push(`RSS ${Math.round(row.rssKb / 1024)} MB`);
  if (row.heapMb != null) bits.push(`heap ${row.heapMb} MB`);
  if (row.ms != null) bits.push(`${row.ms} ms`);
  if (row.bytes != null) bits.push(row.bytes >= 1024 * 1024 ? `${(row.bytes / 1024 / 1024).toFixed(1)} MB file` : `${Math.round(row.bytes / 1024)} KB`);
  if (row.note) bits.push(row.note);
  return bits.join(" | ");
}

const dir = mkdtempSync(join(tmpdir(), "cc-mods-mem-"));
const jsonl10k = join(dir, "10k.jsonl");
const bytes10k = writeJsonl(jsonl10k, 10_000);
const sixMbPath = join(dir, "6mb.jsonl");
writeFileSync(
  sixMbPath,
  `${JSON.stringify({
    uuid: "u",
    type: "assistant",
    message: { content: [{ type: "text", text: "y".repeat(400) }] },
  })}\n`.repeat(12_000),
);
const bytes6mb = statSync(sixMbPath).size;

const idle = await bunEval(`await Bun.sleep(200); ${snapshotExpr()}`);
const parse = await bunEval(`
  import { parseTranscript } from "./src/compacted-history.ts";
  import { readFileSync } from "node:fs";
  const t0 = performance.now();
  const records = parseTranscript(readFileSync(${JSON.stringify(jsonl10k)}, "utf8"));
  const ms = performance.now() - t0;
  ${snapshotExpr("ms,n:records.length")}
`);
const parse6 = await bunEval(`
  import { parseTranscript } from "./src/compacted-history.ts";
  import { readFileSync } from "node:fs";
  const t0 = performance.now();
  const records = parseTranscript(readFileSync(${JSON.stringify(sixMbPath)}, "utf8"));
  const ms = performance.now() - t0;
  ${snapshotExpr("ms,n:records.length")}
`);

const tail = await bunEval(`
  import { tailTranscript } from "./src/jsonl.ts";
  import { appendFileSync, statSync } from "node:fs";
  let woke = 0;
  const path = ${JSON.stringify(jsonl10k)};
  const before = statSync(path).size;
  const t = tailTranscript(path, { onRecord: () => woke++ });
  const t0 = performance.now();
  appendFileSync(path, ${JSON.stringify(`${line(10_000)}\n`)});
  await Bun.sleep(40);
  t.stop();
  process.stdout.write(JSON.stringify({ ms: Math.round((performance.now()-t0)*10)/10, woke, added: statSync(path).size-before }));
`);

const relay = await bunEval(`
  import { startRelay } from "./src/relay.ts";
  const r = startRelay();
  await Bun.sleep(200);
  ${snapshotExpr()}
  r.stop();
`);

const agent = await bunEval(`
  import { mkdtempSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { ClaudeAcpAgent } from "./src/acp-agent.ts";
  import { MODEL_CATALOG } from "./src/model-catalog.ts";
  import { BUILTIN_COMMANDS } from "./src/command-catalog.ts";
  const silent = { log() {}, error() {} };
  const pty = { pid: 1, write() {}, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), kill() {}, resize() {} };
  const client = { sessionUpdate: async () => {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" } }), readTextFile: async () => ({ content: "" }), writeTextFile: async () => ({}), createElicitation: async () => ({ action: "cancel" }) };
  const agent = new ClaudeAcpAgent(client, silent, {
    startEngine: (args) => ({ sessionId: args.sessionId ?? "11111111-1111-4111-8111-111111111111", pty, cwd: args.cwd }),
    modelCatalogSource: async () => MODEL_CATALOG,
    discoverCommands: () => [...BUILTIN_COMMANDS],
    discoverAgents: () => [],
    getSessionInfo: async () => undefined,
    listStoredSessions: async () => [],
    deleteStoredSession: async () => {},
    fastModeProbe: () => false,
  });
  const cwd = mkdtempSync(join(tmpdir(), "cc-mods-agent-"));
  await agent.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
  await agent.newSession({ cwd, mcpServers: [] });
  await Bun.sleep(80);
  ${snapshotExpr()}
  await agent.dispose();
`);

const binPath = [join(root, "dist/cc-mods-relay"), Bun.which("cc-mods-relay") ?? ""].find((p) => {
  try { return statSync(p).size > 0; } catch { return false; }
});

const rows: Row[] = [
  { name: "idle bun", rssKb: idle.rssKb, heapMb: idle.heapMb },
  { name: "parse 10k-event JSONL and hold it", rssKb: parse.rssKb, heapMb: parse.heapMb, ms: Math.round((parse.ms ?? 0) * 10) / 10, bytes: bytes10k, note: "peak if a session were fully materialized" },
  { name: "parse ~6 MB JSONL and hold it", rssKb: parse6.rssKb, heapMb: parse6.heapMb, ms: Math.round((parse6.ms ?? 0) * 10) / 10, bytes: bytes6mb, note: "size of the largest host transcript today" },
  { name: "incremental tail +1 line", ms: tail.ms, bytes: tail.added, note: `wakeups=${tail.woke}; new bytes only` },
  { name: "tool relay (this machine)", rssKb: relay.rssKb, heapMb: relay.heapMb, note: "no session JSONL" },
  { name: "ACP agent, session open, no TUI", rssKb: agent.rssKb, heapMb: agent.heapMb, note: "host stdio agent; Claude TUI is separate" },
];
if (binPath) rows.push({ name: "compiled binary on disk", bytes: statSync(binPath).size, note: "embeds the Bun runtime; not RAM" });
const host = await hostJsonl();
if (host) rows.push(host);

for (const row of rows) console.log(fmt(row));
console.log(JSON.stringify({ bun: Bun.version, platform: `${process.platform}-${process.arch}`, rows }, null, 2));
