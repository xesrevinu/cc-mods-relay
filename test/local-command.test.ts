import { expect, test } from "bun:test";
import { statusCommandOutput, stripLocalCommandMetadata } from "../src/acp-agent.js";

function marked(name: string, stdout: string): string {
  return `<command-name>${name}</command-name>\n<local-command-stdout>${stdout}</local-command-stdout>`;
}

test("usage stdout is forwarded to the ACP client", () => {
  expect(statusCommandOutput(marked("/usage", "in: 12k  out: 800"))).toBe("in: 12k  out: 800");
});

test("model effort and context local commands stay hidden", () => {
  expect(stripLocalCommandMetadata(marked("/model", "switched"))).toBeNull();
  expect(stripLocalCommandMetadata(marked("/effort", "high"))).toBeNull();
  expect(stripLocalCommandMetadata(marked("/context", "100k / 1m used"))).toBeNull();
  expect(statusCommandOutput(marked("/context", "100k / 1m used"))).toBeNull();
});
