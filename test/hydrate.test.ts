import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "../src/exec.js";
import { hydrateTool, miniRelative } from "../src/tools/hydrate.js";

test("hydrate copies a Mac file and maps extra dirs onto Mini", async () => {
  const root = mkdtempSync(join(tmpdir(), "cc-hydrate-"));
  const project = join(root, "proj");
  const extra = join(root, "extra");
  mkdirSync(project);
  mkdirSync(extra);
  writeFileSync(join(project, "a.png"), "PNG");
  writeFileSync(join(extra, "b.txt"), "extra-bytes");

  const fromCwd = await hydrateTool(project, join(root, "tui"), { file_path: join(project, "a.png") });
  expect(fromCwd.relative).toBe("a.png");
  expect(Buffer.from(fromCwd.base64, "base64").toString()).toBe("PNG");

  const fromExtra = await hydrateTool(project, join(root, "tui"), { file_path: join(extra, "b.txt") }, [extra]);
  expect(fromExtra.relative.startsWith(".extra/")).toBe(true);
  expect(miniRelative(project, join(extra, "b.txt"), [extra])).toBe(fromExtra.relative);

  const frame = await new Promise<any>((resolve) => {
    void execute(
      { tool: "hydrate", cwd: project, tuiRoot: join(root, "tui"), input: { file_path: "a.png" } },
      (out) => resolve(out),
    );
  });
  expect(frame.ok).toBe(true);
  expect(frame.result.relative).toBe("a.png");
});
