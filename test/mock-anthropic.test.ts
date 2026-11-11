import { expect, test } from "bun:test";
import { jsonMessage, scriptedEvents, startMockAnthropic, toolResultsFromBody } from "../src/mock-anthropic.js";

test("scripted SSE emits tool_use then end_turn in Anthropic event order", () => {
  const sse = scriptedEvents(
    { blocks: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "hello.txt" } }] },
    "mock",
  );
  expect(sse).toContain("event: message_start");
  expect(sse).toContain("\"name\":\"Read\"");
  expect(sse).toContain("\"type\":\"input_json_delta\"");
  expect(sse).toContain("\"stop_reason\":\"tool_use\"");
  expect(sse.trim().endsWith("event: message_stop\ndata: {\"type\":\"message_stop\"}")).toBe(true);
});

test("mock /v1/messages streams a turn and ignores auxiliary traffic", async () => {
  const mock = startMockAnthropic([
    { blocks: [{ type: "text", text: "main-turn" }] },
  ]);
  try {
    const aux = await fetch(`${mock.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-claude-code-request-class": "auxiliary" },
      body: JSON.stringify({ model: "mock", stream: true, messages: [] }),
    });
    expect(aux.ok).toBe(true);
    expect(await aux.text()).toContain("ok");
    expect(mock.remaining()).toBe(1);

    const main = await fetch(`${mock.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-claude-code-request-class": "main" },
      body: JSON.stringify({ model: "mock", stream: true, tools: [{ name: "Read" }], messages: [] }),
    });
    expect(await main.text()).toContain("main-turn");
    expect(mock.remaining()).toBe(0);

    const counted = await fetch(`${mock.url}/v1/messages/count_tokens`, { method: "POST", body: "{}" });
    expect(await counted.json()).toEqual({ input_tokens: 48 });

    expect((await fetch(`${mock.url}/api/hello`)).status).toBe(200);
    expect((await fetch(`${mock.url}/api/hello`, { method: "HEAD" })).status).toBe(200);
    expect((await fetch(`${mock.url}/v1/oauth/hello`)).status).toBe(200);
  } finally {
    mock.stop();
  }
});

test("non-stream JSON message carries tool_use blocks", () => {
  const msg = jsonMessage(
    { blocks: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pwd" } }] },
    "mock",
  );
  expect(msg.stop_reason).toBe("tool_use");
  expect(msg.content[0]).toMatchObject({ name: "Bash" });
});

test("toolResultsFromBody reads tool_result blocks off the next request", () => {
  const found = toolResultsFromBody({
    messages: [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hello" }],
      },
    ],
  });
  expect(found).toEqual([{ toolUseId: "toolu_1", content: "hello" }]);
});
