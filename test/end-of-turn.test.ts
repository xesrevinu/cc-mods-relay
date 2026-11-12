import { expect, test } from "bun:test";
import { createEndOfTurnDetector, type DetectorSchedule } from "../src/end-of-turn.js";

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
