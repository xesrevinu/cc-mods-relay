import type { SessionNotification, ToolCallContent } from "@agentclientprotocol/sdk/unstable";
import type { ModEvent } from "./mod-channel.js";
import { markdownEscape, toolInfoFromToolUse, toolUpdateFromToolResult } from "./tools.js";
import { toUsageUpdate } from "./usage.js";

export type ModLiveClient = {
  sessionUpdate(params: SessionNotification): Promise<void>;
};

type Started = { tool: string; input: Record<string, unknown> };

function meta(parentToolUseId: unknown) {
  return typeof parentToolUseId === "string" ? { claudeCode: { parentToolUseId } } : undefined;
}

function bashText(result: unknown): { text: string; exitCode?: number } {
  if (typeof result === "string") return { text: result };
  const r = (result ?? {}) as Record<string, unknown>;
  const text = [r.stdout, r.stderr].filter((s): s is string => typeof s === "string" && s !== "").join("\n");
  const exitCode = [r.exitCode, r.exit_code].find((c): c is number => typeof c === "number");
  return { text, exitCode };
}

/** Map one Mods event to ACP session/update notifications. */
export async function applyModEvent(
  sessionId: string,
  event: ModEvent,
  ctx: {
    client: ModLiveClient;
    tools: Map<string, Started>;
    cwd: string;
    supportsTerminal: boolean;
    contextWindowSize?: number;
  },
): Promise<"turn_started" | "turn_completed" | undefined> {
  if (event.type === "chunk" && typeof event.text === "string") {
    await ctx.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: event.kind === "thinking" ? "agent_thought_chunk" : "agent_message_chunk",
        content: { type: "text", text: event.text },
        ...(meta(event.parentToolUseId) ? { _meta: meta(event.parentToolUseId) } : {}),
      },
    });
    return;
  }

  if (event.type === "tool_started" && typeof event.toolUseId === "string" && typeof event.tool === "string") {
    const input = (event.input && typeof event.input === "object" ? event.input : {}) as Record<string, unknown>;
    ctx.tools.set(event.toolUseId, { tool: event.tool, input });
    const info = toolInfoFromToolUse({ id: event.toolUseId, name: event.tool, input }, ctx.supportsTerminal, ctx.cwd);
    const parent = meta(event.parentToolUseId);
    await ctx.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: event.toolUseId,
        name: event.tool,
        status: "pending",
        rawInput: input,
        _meta: { claudeCode: { toolName: event.tool, ...(parent?.claudeCode ?? {}) } },
        ...info,
      },
    });
    await ctx.client.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "tool_call_update", toolCallId: event.toolUseId, status: "in_progress" },
    });
    if (!event.parentToolUseId && event.tool === "TodoWrite" && Array.isArray(input.todos)) {
      const entries = (input.todos as { content?: string; status?: string; activeForm?: string }[]).map((todo) => ({
        content: todo.status === "in_progress" && todo.activeForm ? todo.activeForm : String(todo.content ?? ""),
        status: (todo.status === "in_progress" || todo.status === "completed" ? todo.status : "pending") as "pending" | "in_progress" | "completed",
        priority: "medium" as const,
      }));
      if (entries.length) await ctx.client.sessionUpdate({ sessionId, update: { sessionUpdate: "plan", entries } });
    }
    return;
  }

  if (event.type === "tool_finished" && typeof event.toolUseId === "string") {
    const started = ctx.tools.get(event.toolUseId);
    const isError = event.isError === true;
    const out = started?.tool === "Bash" || started?.tool === "PowerShell" ? bashText(event.result) : undefined;
    const terminal = Boolean(out && ctx.supportsTerminal);
    const parent = meta(event.parentToolUseId);
    const mapped = started
      ? toolUpdateFromToolResult(
          { type: "tool_result", tool_use_id: event.toolUseId, content: "", is_error: isError },
          { name: started.tool, id: event.toolUseId, input: started.input },
          ctx.supportsTerminal,
          event.result,
        )
      : {};
    let content = mapped.content as ToolCallContent[] | undefined;
    if (!content?.length && out && !terminal && out.text) {
      content = [{ type: "content", content: { type: "text", text: `\`\`\`console\n${out.text.trimEnd()}\n\`\`\`` } }];
    }
    if (!content?.length && event.result != null && started?.tool !== "Write" && started?.tool !== "Edit") {
      const heavy = event.result && typeof event.result === "object"
        ? (event.result as { type?: string; file?: { base64?: string } })
        : undefined;
      if (heavy?.type === "image" && heavy.file?.base64) {
        content = [{
          type: "content",
          content: {
            type: "image",
            data: heavy.file.base64,
            mimeType: typeof (heavy.file as { type?: string }).type === "string"
              ? (heavy.file as { type: string }).type
              : "application/octet-stream",
          },
        }];
      } else if (heavy?.type !== "image" && heavy?.type !== "pdf") {
        const text = typeof event.result === "string" ? event.result : JSON.stringify(event.result, null, 2);
        if (text && text !== "{}" && text !== '""') {
          content = [{ type: "content", content: { type: "text", text: markdownEscape(text) } }];
        }
      }
    }
    await ctx.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: event.toolUseId,
        status: isError ? "failed" : "completed",
        rawOutput: event.result,
        ...(mapped.title ? { title: mapped.title } : {}),
        ...(content?.length ? { content } : {}),
        ...(parent || terminal || mapped._meta
          ? {
              _meta: {
                ...(parent ?? {}),
                ...(mapped._meta ?? {}),
                ...(terminal
                  ? {
                      terminal_output: { terminal_id: event.toolUseId, data: out!.text },
                      terminal_exit: {
                        terminal_id: event.toolUseId,
                        exit_code: out!.exitCode ?? (isError ? 1 : 0),
                        signal: null,
                      },
                    }
                  : {}),
              },
            }
          : {}),
      },
    });
    ctx.tools.delete(event.toolUseId);
    return;
  }

  if (event.type === "usage") {
    const update = toUsageUpdate(
      {
        usage: {
          input_tokens: typeof event.inputTokens === "number" ? event.inputTokens : null,
          output_tokens: typeof event.outputTokens === "number" ? event.outputTokens : null,
          cache_read_input_tokens: typeof event.cachedReadTokens === "number" ? event.cachedReadTokens : null,
          cache_creation_input_tokens:
            typeof event.cachedWriteTokens === "number" ? event.cachedWriteTokens : null,
        },
      },
      { contextWindowSize: ctx.contextWindowSize },
    );
    if (update) await ctx.client.sessionUpdate({ sessionId, update });
    return;
  }

  if (event.type === "title" && typeof event.title === "string") {
    await ctx.client.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "session_info_update", title: event.title, updatedAt: new Date().toISOString() },
    });
    return;
  }

  if (event.type === "turn_started") return "turn_started";
  if (event.type === "turn_completed") return "turn_completed";
  return undefined;
}

export function stopReasonFromMod(reason: unknown): string {
  if (reason === "max_tokens") return "max_tokens";
  if (reason === "refusal") return "refusal";
  return "end_turn";
}
