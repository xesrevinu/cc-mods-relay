import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogValueFromTranscriptModel } from "../src/model-catalog.js";
import { readTranscriptModel, readTranscriptPermissionMode } from "../src/resumed-permission-mode.js";

function jsonl(dir: string, rows: unknown[]): string {
  const path = join(dir, "s.jsonl");
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return path;
}

test("readTranscriptModel takes the last main-thread assistant model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-resume-"));
  const path = jsonl(dir, [
    { type: "user", message: { role: "user", content: "hi" }, cwd: "/Users/alice/proj" },
    { type: "assistant", message: { role: "assistant", model: "claude-haiku-5-5", content: [] } },
    { type: "assistant", isSidechain: true, message: { role: "assistant", model: "claude-sonnet-5-5", content: [] } },
    { type: "assistant", message: { role: "assistant", model: "claude-fable-5-1", content: [] } },
  ]);
  expect(await readTranscriptModel(path)).toBe("claude-fable-5-1");
  expect(catalogValueFromTranscriptModel("claude-fable-5-1")).toBe("fable");
  expect(catalogValueFromTranscriptModel("claude-haiku-5-5")).toBe("haiku");
  expect(catalogValueFromTranscriptModel("sonnet")).toBe("sonnet");
});

test("readTranscriptModel skips sessions that never produced an assistant", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-resume-"));
  const path = jsonl(dir, [
    { type: "user", message: { role: "user", content: "hi" } },
    { type: "permission-mode", permissionMode: "bypassPermissions" },
  ]);
  expect(await readTranscriptModel(path)).toBeUndefined();
  expect(await readTranscriptPermissionMode(path)).toBe("bypassPermissions");
});
