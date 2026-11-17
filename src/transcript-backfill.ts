import { mkdirSync } from "node:fs";
import { quote, rsh } from "./ssh.js";
import { debug } from "./debug.js";
import { localProjectsRoot, stampLocalTranscripts, type TranscriptCursors } from "./transcript-mirror.js";

export type BackfillRun = (argv: string[]) => Promise<{ code: number; stderr: string }>;

export type TranscriptBackfillOpts = {
  host: string;
  dest?: string;
  run?: BackfillRun;
  now?: () => string;
  configDir?: string;
};

async function spawnRsync(argv: string[]): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code: code ?? 1, stderr };
}

/** rsync Mini Claude project session JSONL onto this machine. Sidecars stay local. */
export function rsyncBackfillArgv(host: string, dest: string): string[] {
  const ssh = rsh().map((part) => (/\s/.test(part) ? quote(part) : part)).join(" ");
  const target = dest.endsWith("/") ? dest : `${dest}/`;
  return [
    "rsync",
    "-az",
    "--partial",
    "--inplace",
    "-e",
    ssh,
    "--include=*/",
    "--include=*.jsonl",
    "--exclude=*",
    `${host}:.claude/projects/`,
    target,
  ];
}

export async function backfillTranscripts(
  opts: TranscriptBackfillOpts,
): Promise<{ files: number; cursors: TranscriptCursors }> {
  const dest = opts.dest ?? localProjectsRoot();
  mkdirSync(dest, { recursive: true });
  const argv = rsyncBackfillArgv(opts.host, dest);
  const run = opts.run ?? spawnRsync;
  const ran = await run(argv);
  if (ran.code !== 0) {
    throw new Error(`rsync transcript backfill failed (${ran.code}): ${ran.stderr.trim() || "no stderr"}`);
  }
  const stamped = stampLocalTranscripts(dest, "rsync-backfill", {
    now: opts.now,
    configDir: opts.configDir,
  });
  debug("transcript rsync-backfill", { host: opts.host, files: stamped.files });
  return stamped;
}
