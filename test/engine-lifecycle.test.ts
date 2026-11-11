import { expect, test } from "bun:test";
import { buildResumeArgv, SessionEngine } from "../src/engine-lifecycle.js";
import type { EngineTerminal } from "../src/terminal-backend.js";

const SOURCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FORK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("resume falls back to a fresh claude if the source session is missing", () => {
  const [, cmd] = buildResumeArgv(SOURCE);
  expect(cmd).toBe(`claude --resume "${SOURCE}" || exec claude`);
});

test("fork resumes the source session under a new session id", () => {
  const [, cmd] = buildResumeArgv(SOURCE, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
    forkSessionId: FORK,
  });
  expect(cmd).toBe(
    `exec claude --resume "${SOURCE}" --fork-session --session-id "${FORK}"`,
  );
  expect(cmd).not.toContain("|| claude");
});

test("engine kill reaps the TUI even after cleanup has marked it disposed", () => {
  let killed = 0;
  const pty = {
    pid: 1,
    write() {},
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    kill() {
      killed += 1;
    },
    resize() {},
  } as EngineTerminal;
  const engine = new SessionEngine({ handle: { sessionId: SOURCE, pty } });
  engine.cleanup();
  expect(engine.isDisposed).toBe(true);
  engine.kill();
  expect(killed).toBe(1);
});
