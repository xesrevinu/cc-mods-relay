import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { peekTranscript, selectTranscript } from "../src/jsonl.js";

test("peekTranscript returns cwd from inside the jsonl", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-jsonl-"));
  const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ cwd: "/Users/alice/proj" })}\n`);
  const peeked = peekTranscript(sessionId, { glob: (id) => (id === sessionId ? [path] : []) });
  expect(peeked).toEqual({ transcriptPath: path, cwd: "/Users/alice/proj" });
});

test("selectTranscript prefers the jsonl whose cwd matches", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-jsonl-"));
  const a = join(dir, "a.jsonl");
  const b = join(dir, "b.jsonl");
  writeFileSync(a, `${JSON.stringify({ cwd: "/Users/bob/old" })}\n`);
  writeFileSync(b, `${JSON.stringify({ cwd: "/Users/alice/proj" })}\n`);
  expect(selectTranscript([a, b], "/Users/alice/proj")).toBe(b);
});

test("selectTranscript picks the newest file when cwd is not in any jsonl", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-jsonl-"));
  const older = join(dir, "older.jsonl");
  const newer = join(dir, "newer.jsonl");
  writeFileSync(older, `${JSON.stringify({ cwd: "/Users/bob/old" })}\n`);
  await Bun.sleep(20);
  writeFileSync(newer, `${JSON.stringify({ cwd: "/Users/bob/mapped" })}\n`);
  expect(selectTranscript([older, newer])).toBe(newer);
});

test("peekTranscript is undefined when glob is empty", () => {
  expect(peekTranscript("missing-id", { glob: () => [] })).toBeUndefined();
});
