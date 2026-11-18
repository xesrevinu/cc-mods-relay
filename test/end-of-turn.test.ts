import { expect, test } from "bun:test";
import {
  CODE_MODE_ANSWER_MS,
  CODE_MODE_QUIET_MS,
  createEndOfTurnDetector,
  type DetectorSchedule,
} from "../src/end-of-turn.js";

function fakeClock(): {
  schedule: DetectorSchedule;
  advance: (ms: number) => void;
} {
  let now = 0;
  const timers: { at: number; fn: () => void; dead: boolean }[] = [];
  return {
    schedule(fn, ms) {
      const t = { at: now + ms, fn, dead: false };
      timers.push(t);
      return () => {
        t.dead = true;
      };
    },
    advance(ms) {
      now += ms;
      for (const t of [...timers]) {
        if (t.dead || t.at > now) continue;
        t.dead = true;
        t.fn();
      }
    },
  };
}

test("stall watchdog fires only after inactivity, not wall-clock from beginTurn", () => {
  const clock = fakeClock();
  const ends: unknown[] = [];
  const timeouts: string[] = [];
  const detector = createEndOfTurnDetector({
    onEndOfTurn: (b) => ends.push(b),
    onTurnTimeout: (e) => timeouts.push(e.message),
    schedule: clock.schedule,
    watchdogMs: 100,
    deltaTMs: 10,
  });
  detector.beginTurn();
  clock.advance(90);
  detector.noteActivity();
  clock.advance(90);
  expect(timeouts).toEqual([]);
  clock.advance(20);
  expect(timeouts.length).toBe(1);
  expect(timeouts[0]).toContain("100ms turn watchdog");
  expect(ends).toEqual([]);
});

test("an in-flight Mods tool holds the stall watchdog until it finishes", () => {
  const clock = fakeClock();
  const timeouts: string[] = [];
  const detector = createEndOfTurnDetector({
    onEndOfTurn: () => {},
    onTurnTimeout: (e) => timeouts.push(e.message),
    schedule: clock.schedule,
    watchdogMs: 100,
    deltaTMs: 10,
  });
  detector.beginTurn();
  detector.hold("tool-1");
  clock.advance(250);
  expect(timeouts).toEqual([]);
  detector.release("tool-1");
  clock.advance(90);
  expect(timeouts).toEqual([]);
  clock.advance(20);
  expect(timeouts.length).toBe(1);
});

test("finish waits for in-flight tools before ending the turn", () => {
  const clock = fakeClock();
  const ends: unknown[] = [];
  const detector = createEndOfTurnDetector({
    onEndOfTurn: (b) => ends.push(b),
    schedule: clock.schedule,
    watchdogMs: 1000,
    deltaTMs: 10,
  });
  detector.beginTurn();
  detector.hold("bash-1");
  detector.finish("end_turn");
  clock.advance(50);
  expect(ends).toEqual([]);
  detector.release("bash-1");
  expect(ends).toHaveLength(1);
});

test("finish with settleMs waits for a late tool then confirms after idle", () => {
  const clock = fakeClock();
  const ends: unknown[] = [];
  const detector = createEndOfTurnDetector({
    onEndOfTurn: (b) => ends.push(b),
    schedule: clock.schedule,
    watchdogMs: 10_000,
    deltaTMs: 10,
    settleMs: 40,
  });
  detector.beginTurn();
  detector.finish("end_turn");
  clock.advance(20);
  expect(ends).toEqual([]);
  detector.hold("bash-1");
  clock.advance(100);
  expect(ends).toEqual([]);
  detector.release("bash-1");
  clock.advance(20);
  expect(ends).toEqual([]);
  clock.advance(20);
  expect(ends).toHaveLength(1);
});

test("JSONL writes do not cancel a Code Mode settle wait", () => {
  const clock = fakeClock();
  const ends: unknown[] = [];
  const detector = createEndOfTurnDetector({
    onEndOfTurn: (b) => ends.push(b),
    schedule: clock.schedule,
    watchdogMs: 10_000,
    deltaTMs: 10,
    settleMs: 40,
  });
  detector.beginTurn();
  detector.finish("end_turn");
  detector.observe({ type: "assistant", message: { content: [{ type: "text", text: "x" }] } });
  clock.advance(20);
  expect(ends).toEqual([]);
  clock.advance(20);
  expect(ends).toHaveLength(1);
});

test("release after finish waits for a follow-up answer, not another full settleMs", () => {
  const clock = fakeClock();
  const ends: unknown[] = [];
  const detector = createEndOfTurnDetector({
    onEndOfTurn: (b) => ends.push(b),
    schedule: clock.schedule,
    watchdogMs: 20_000,
    deltaTMs: 10,
    settleMs: 20_000,
  });
  detector.beginTurn();
  detector.hold("bash-1");
  detector.finish("end_turn");
  clock.advance(50);
  expect(ends).toEqual([]);
  detector.release("bash-1");
  clock.advance(CODE_MODE_ANSWER_MS - 1);
  expect(ends).toEqual([]);
  clock.advance(1);
  expect(ends).toHaveLength(1);
});

test("answer chunks after the last tool shrink the wait to the quiet window", () => {
  const clock = fakeClock();
  const ends: unknown[] = [];
  const detector = createEndOfTurnDetector({
    onEndOfTurn: (b) => ends.push(b),
    schedule: clock.schedule,
    watchdogMs: 20_000,
    deltaTMs: 10,
    settleMs: 10_000,
  });
  detector.beginTurn();
  detector.hold("bash-1");
  detector.finish("end_turn");
  detector.release("bash-1");
  clock.advance(100);
  detector.noteActivity();
  clock.advance(CODE_MODE_QUIET_MS - 1);
  expect(ends).toEqual([]);
  clock.advance(1);
  expect(ends).toHaveLength(1);
});

test("finish after tools have run still waits for a follow-up answer", () => {
  const clock = fakeClock();
  const ends: unknown[] = [];
  const detector = createEndOfTurnDetector({
    onEndOfTurn: (b) => ends.push(b),
    schedule: clock.schedule,
    watchdogMs: 10_000,
    deltaTMs: 10,
    settleMs: 40,
  });
  detector.beginTurn();
  detector.hold("bash-1");
  detector.release("bash-1");
  detector.finish("end_turn");
  expect(ends).toEqual([]);
  clock.advance(40);
  expect(ends).toHaveLength(1);
});
