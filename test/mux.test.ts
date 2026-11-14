import { expect, test } from "bun:test";
import { classify, createAcpByteDuplex, encodeNdjson } from "../src/mux.js";

test("classify splits ACP JSON-RPC from v1 control frames", () => {
  expect(classify({ jsonrpc: "2.0", id: 1, method: "initialize" })).toBe("acp");
  expect(classify({ jsonrpc: "2.0", id: 1, result: {} })).toBe("acp");
  expect(classify({ jsonrpc: "2.0", method: "session/cancel", params: {} })).toBe("acp");
  expect(classify({ v: 1, type: "hello", token: "t" })).toBe("ctrl");
  expect(classify({ v: 1, type: "call", tool: "Read" })).toBe("ctrl");
  expect(classify({ v: 1, type: "instance.start" })).toBe("ctrl");
  expect(classify({ type: "call" })).toBeUndefined();
  expect(classify(null)).toBeUndefined();
  expect(classify("nope")).toBeUndefined();
});

test("ACP byte duplex turns NDJSON writes into objects and pushAcp into bytes", async () => {
  const sent: unknown[] = [];
  const duplex = createAcpByteDuplex((msg) => sent.push(msg));
  const writer = duplex.writable.getWriter();
  await writer.write(encodeNdjson({ jsonrpc: "2.0", id: 1, method: "initialize" }));
  await writer.write(new TextEncoder().encode(`{"jsonrpc":"2.0","id":2,"method":"session/new"}\n`));
  expect(sent).toEqual([
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    { jsonrpc: "2.0", id: 2, method: "session/new" },
  ]);

  const reader = duplex.readable.getReader();
  duplex.pushAcp({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  const chunk = await reader.read();
  expect(chunk.done).toBe(false);
  expect(new TextDecoder().decode(chunk.value)).toBe(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })}\n`);
  duplex.close();
});
