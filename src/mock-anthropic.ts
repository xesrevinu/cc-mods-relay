/**
 * Scripted Anthropic Messages API for an isolated Claude Code.
 *
 * Point Claude at this process with ANTHROPIC_BASE_URL (no /v1 suffix).
 * Main-session POSTs to /v1/messages consume the turn queue; auxiliary
 * traffic (titles, classifiers, token counts) gets a short text reply and
 * does not burn a turn.
 */
export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};
export type ContentBlock = TextBlock | ToolUseBlock;

export type ScriptedTurn = {
  blocks: ContentBlock[];
  stopReason?: "end_turn" | "tool_use";
};

export type RecordedRequest = {
  method: string;
  path: string;
  requestClass: string | null;
  body: unknown;
};

export type MockAnthropic = {
  url: string;
  port: number;
  requests: RecordedRequest[];
  remaining: () => number;
  stop: () => void;
};

function sseChunk(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function scriptedEvents(turn: ScriptedTurn, model: string): string {
  const stopReason =
    turn.stopReason ?? (turn.blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
  const chunks: string[] = [
    sseChunk("message_start", {
      type: "message_start",
      message: {
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 32, output_tokens: 0 },
      },
    }),
  ];
  turn.blocks.forEach((block, index) => {
    if (block.type === "text") {
      chunks.push(
        sseChunk("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        }),
        sseChunk("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: block.text },
        }),
      );
    } else {
      chunks.push(
        sseChunk("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
        }),
        sseChunk("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        }),
      );
    }
    chunks.push(sseChunk("content_block_stop", { type: "content_block_stop", index }));
  });
  chunks.push(
    sseChunk("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 8 },
    }),
    sseChunk("message_stop", { type: "message_stop" }),
  );
  return chunks.join("");
}

export function jsonMessage(turn: ScriptedTurn, model: string) {
  const stopReason =
    turn.stopReason ?? (turn.blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
  return {
    id: "msg_mock",
    type: "message",
    role: "assistant",
    model,
    content: turn.blocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 32, output_tokens: 8 },
  };
}

export function toolResultsFromBody(body: unknown): { toolUseId: string; content: unknown }[] {
  if (!body || typeof body !== "object") return [];
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];
  const out: { toolUseId: string; content: unknown }[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const row = block as { type?: string; tool_use_id?: string; content?: unknown };
      if (row.type === "tool_result" && typeof row.tool_use_id === "string") {
        out.push({ toolUseId: row.tool_use_id, content: row.content });
      }
    }
  }
  return out;
}

function isMainInference(req: Request, body: unknown): boolean {
  const cls = req.headers.get("x-claude-code-request-class");
  if (cls === "auxiliary" || cls === "compaction") return false;
  if (cls === "main" || cls === "subagent" || cls === "workflow") return true;
  if (!body || typeof body !== "object") return false;
  const tools = (body as { tools?: unknown }).tools;
  return Array.isArray(tools) && tools.length > 0;
}

const AUX: ScriptedTurn = { blocks: [{ type: "text", text: "ok" }] };

export function startMockAnthropic(turns: ScriptedTurn[]): MockAnthropic {
  const queue = [...turns];
  const requests: RecordedRequest[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      // TUI preflight (if it ever honors BASE_URL) GETs these and requires HTTP 200.
      if (path === "/api/hello" || path === "/v1/oauth/hello") {
        return new Response(null, { status: 200 });
      }
      if (req.method === "POST" && path === "/v1/messages/count_tokens") {
        return Response.json({ input_tokens: 48 });
      }
      if (req.method !== "POST" || path !== "/v1/messages") {
        requests.push({ method: req.method, path, requestClass: req.headers.get("x-claude-code-request-class"), body: null });
        return Response.json({ error: { type: "not_found_error", message: path } }, { status: 404 });
      }
      const body = await req.json().catch(() => ({}));
      const requestClass = req.headers.get("x-claude-code-request-class");
      requests.push({ method: req.method, path, requestClass, body });
      const model = typeof (body as { model?: unknown }).model === "string" ? (body as { model: string }).model : "mock";
      const turn = isMainInference(req, body) ? queue.shift() ?? { blocks: [{ type: "text", text: "no scripted turn left" }] } : AUX;
      const stream = (body as { stream?: unknown }).stream !== false;
      if (!stream) return Response.json(jsonMessage(turn, model));
      return new Response(scriptedEvents(turn, model), {
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
      });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port ?? 0,
    requests,
    remaining: () => queue.length,
    stop() {
      server.stop(true);
    },
  };
}

export function assertMockBaseUrl(env: NodeJS.ProcessEnv = process.env): void {
  if (env.CC_MODS_MOCK !== "1") return;
  const url = env.ANTHROPIC_BASE_URL ?? "";
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(url)) {
    throw new Error("CC_MODS_MOCK=1 requires ANTHROPIC_BASE_URL on 127.0.0.1 (refusing to hit the real API)");
  }
}

if (import.meta.main) {
  const mock = startMockAnthropic([
    {
      blocks: [{ type: "tool_use", id: "toolu_01MockReadHelloTxt000000000", name: "Read", input: { file_path: "hello.txt" } }],
    },
    { blocks: [{ type: "text", text: "ok" }] },
  ]);
  console.error(`ANTHROPIC_BASE_URL=${mock.url}`);
  console.error("POST /v1/messages is scripted: Read hello.txt, then text.");
}
