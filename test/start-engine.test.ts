import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultStartEngine } from "../src/acp-agent.js";
import type { EngineTerminal, TerminalSpawn } from "../src/terminal-backend.js";

function fakePty(): EngineTerminal {
  return {
    pid: 1,
    write() {},
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    kill() {},
    resize() {},
  };
}

test("resume spawn cds into the transcript cwd, not the remapped tuiRoot", async () => {
  const sessionId = randomUUID();
  const transcriptCwd = mkdtempSync(join(tmpdir(), "cc-mods-jsonl-cwd-"));
  const mappedCwd = mkdtempSync(join(tmpdir(), "cc-mods-mapped-cwd-"));
  const transcript = join(transcriptCwd, `${sessionId}.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({ cwd: transcriptCwd })}\n`);
  const spawned: Array<string | undefined> = [];
  const spawn: TerminalSpawn = (_file, _args, options) => {
    spawned.push(options.cwd);
    return fakePty();
  };
  const started = await defaultStartEngine({
    sessionId,
    cwd: mappedCwd,
    resume: true,
    spawn,
    locateOptions: { glob: (id) => (id === sessionId ? [transcript] : []) },
  });
  expect(spawned).toEqual([transcriptCwd]);
  expect(started.cwd).toBe(transcriptCwd);
  started.engine?.kill();
});
