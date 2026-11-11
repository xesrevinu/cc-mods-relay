import { expect, test } from "bun:test";
import { applyModEvent } from "../src/mod-live.js";
import { WORKSPACE_TOOLS } from "../src/tools/forward.js";
import { ACP_KIND, assertAcpNotification } from "./acp-schema.js";

const SAMPLE: Record<string, Record<string, unknown>> = {
  Read: { file_path: "/tmp/proj/hello.txt" },
  Write: { file_path: "/tmp/proj/created.txt", content: "hi\n" },
  Edit: { file_path: "/tmp/proj/hello.txt", old_string: "a", new_string: "b" },
  Glob: { pattern: "*.txt", path: "/tmp/proj" },
  Grep: { pattern: "hello", path: "/tmp/proj" },
  NotebookEdit: { notebook_path: "/tmp/proj/n.ipynb", cell_id: "c1", new_source: "print(2)", edit_mode: "replace" },
  Bash: { command: "echo hi" },
  PowerShell: { command: "Write-Output hi" },
};

test("every workspace tool maps to a schema-valid ACP tool_call", async () => {
  for (const tool of WORKSPACE_TOOLS) {
    const notes: unknown[] = [];
    const client = {
      sessionUpdate: async (note: any) => {
        assertAcpNotification(note);
        notes.push(note.update);
      },
    };
    const tools = new Map<string, { tool: string; input: Record<string, unknown> }>();
    const id = `toolu_${tool}`;
    await applyModEvent("s1", { type: "tool_started", toolUseId: id, tool, input: SAMPLE[tool] }, {
      client, tools, cwd: "/tmp/proj", supportsTerminal: false,
    });
    const result =
      tool === "Read"
        ? { type: "text", file: { content: "hi", startLine: 1, numLines: 1, totalLines: 1 } }
        : { ok: true };
    await applyModEvent("s1", { type: "tool_finished", toolUseId: id, isError: false, result }, {
      client, tools, cwd: "/tmp/proj", supportsTerminal: false,
    });
    const started = notes.find((u: any) => u.sessionUpdate === "tool_call");
    const progress = notes.find((u: any) => u.sessionUpdate === "tool_call_update" && u.status === "in_progress");
    const done = notes.find((u: any) => u.sessionUpdate === "tool_call_update" && u.status === "completed");
    expect(started, tool).toMatchObject({ toolCallId: id, name: tool, kind: ACP_KIND[tool], status: "pending" });
    expect(progress, tool).toBeDefined();
    expect(done, tool).toMatchObject({ toolCallId: id, status: "completed" });
    if (tool === "Read") {
      expect(JSON.stringify(done)).toContain("hi");
    }
  }
});

test("text and thinking chunks are schema-valid ACP updates", async () => {
  const notes: unknown[] = [];
  const client = { sessionUpdate: async (note: any) => { assertAcpNotification(note); notes.push(note.update); } };
  const ctx = { client, tools: new Map(), cwd: "/tmp", supportsTerminal: false };
  await applyModEvent("s1", { type: "chunk", kind: "text", text: "hello" }, ctx);
  await applyModEvent("s1", { type: "chunk", kind: "thinking", text: "hmm" }, ctx);
  expect(notes).toEqual([
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } },
  ]);
});
