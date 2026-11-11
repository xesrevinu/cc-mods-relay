import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_COMMANDS, discoverCommands } from "../src/command-catalog.js";

function names(commands: readonly { name: string }[]): string[] {
  return commands.map((c) => c.name);
}

test("ACP builtins are session config plus usage and context", () => {
  expect(names(BUILTIN_COMMANDS).sort()).toEqual(["context", "effort", "fast", "model", "usage"]);
  expect(BUILTIN_COMMANDS.find((c) => c.name === "effort")?.input?.hint).toContain("low");
  for (const name of [
    "compact",
    "plan",
    "debug",
    "diff",
    "sandbox",
    "verify",
    "plugin",
    "skills",
    "mcp",
    "review",
  ]) {
    expect(names(BUILTIN_COMMANDS)).not.toContain(name);
  }
});

test("discoverCommands merges project commands with ACP builtins", () => {
  const root = mkdtempSync(join(tmpdir(), "cc-mods-cmds-"));
  const dir = join(root, ".claude", "commands");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ship.md"), "---\ndescription: Ship it\nargument-hint: target\n---\n");
  const listed = discoverCommands(root, { homedir: () => join(root, "home") });
  expect(listed.find((c) => c.name === "ship")).toEqual({
    name: "ship",
    description: "Ship it",
    input: { hint: "target" },
  });
  expect(names(listed)).toContain("effort");
});
