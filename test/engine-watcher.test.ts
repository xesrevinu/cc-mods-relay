import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlWatcher } from "../src/engine-watcher.js";
import { tailTranscript } from "../src/jsonl.js";

test("jsonl watcher wakes on new bytes without loading the transcript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-watch-"));
  const path = join(dir, "s.jsonl");
  writeFileSync(path, "");
  let wakes = 0;
  let loaded = 0;
  const watcher = createJsonlWatcher({
    sessionId: "11111111-1111-4111-8111-111111111111",
    transcriptPath: path,
    debounceMs: 5,
    tail: tailTranscript,
    getMessages: async () => {
      loaded += 1;
      return [{ uuid: "never" }];
    },
    onEvent: () => {
      wakes += 1;
    },
  });
  appendFileSync(path, `${JSON.stringify({ uuid: "a", type: "user" })}\n`);
  await Bun.sleep(40);
  watcher.stop();
  expect(wakes).toBeGreaterThanOrEqual(1);
  expect(loaded).toBe(0);
});
