import {
  ContentBlock,
  PlanEntry,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk/unstable";
import { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import {
  AgentInput,
  AgentOutput,
  BashInput,
  BashOutput,
  FileEditInput,
  FileReadInput,
  FileReadOutput,
  FileWriteInput,
  GlobInput,
  GrepInput,
  TaskCreateInput,
  TaskCreateOutput,
  TaskListOutput,
  TaskUpdateInput,
  TaskUpdateOutput,
  TodoWriteInput,
  WebFetchInput,
  WebSearchInput,
  WebSearchOutput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import {
  ImageBlockParam,
  TextBlockParam,
  ToolResultBlockParam,
  WebSearchResultBlock,
  WebSearchToolResultBlockParam,
  WebSearchToolResultError,
} from "@anthropic-ai/sdk/resources";
import {
  BetaBashCodeExecutionResultBlock,
  BetaBashCodeExecutionToolResultBlockParam,
  BetaBashCodeExecutionToolResultError,
  BetaCodeExecutionResultBlock,
  BetaCodeExecutionToolResultBlockParam,
  BetaCodeExecutionToolResultError,
  BetaImageBlockParam,
  BetaRequestMCPToolResultBlockParam,
  BetaTextEditorCodeExecutionCreateResultBlock,
  BetaTextEditorCodeExecutionStrReplaceResultBlock,
  BetaTextEditorCodeExecutionToolResultBlockParam,
  BetaTextEditorCodeExecutionToolResultError,
  BetaTextEditorCodeExecutionViewResultBlock,
  BetaToolReferenceBlock,
  BetaToolResultBlockParam,
  BetaToolSearchToolResultBlockParam,
  BetaToolSearchToolResultError,
  BetaToolSearchToolSearchResultBlock,
  BetaWebFetchBlock,
  BetaWebFetchToolResultBlockParam,
  BetaWebFetchToolResultErrorBlock,
  BetaWebSearchToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta.mjs";
import path from "node:path";
import { Logger } from "./acp-agent.js";
import type { BackgroundTaskEnd } from "./background-task-end.js";

type ToolResultContent =
  | TextBlockParam
  | ImageBlockParam
  | BetaImageBlockParam
  | BetaToolReferenceBlock
  | BetaToolSearchToolSearchResultBlock
  | BetaToolSearchToolResultError
  | WebSearchResultBlock
  | WebSearchToolResultError
  | BetaWebFetchBlock
  | BetaWebFetchToolResultErrorBlock
  | BetaCodeExecutionResultBlock
  | BetaCodeExecutionToolResultError
  | BetaBashCodeExecutionResultBlock
  | BetaBashCodeExecutionToolResultError
  | BetaTextEditorCodeExecutionViewResultBlock
  | BetaTextEditorCodeExecutionCreateResultBlock
  | BetaTextEditorCodeExecutionStrReplaceResultBlock
  | BetaTextEditorCodeExecutionToolResultError;

interface ToolInfo {
  title: string;
  kind: ToolKind;
  content: ToolCallContent[];
  locations?: ToolCallLocation[];
}

interface ToolUpdate {
  title?: string;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  _meta?: {
    terminal_info?: {
      terminal_id: string;
    };
    terminal_output?: {
      terminal_id: string;
      data: string;
    };
    terminal_exit?: {
      terminal_id: string;
      exit_code: number | null;
      signal: string | null;
    };
  };
}

export type BackgroundExitPolicy = {
  ended: (toolUseId: string) => BackgroundTaskEnd | undefined;
  holdRunning: boolean;
};

function failureExitCode(text: string): number | undefined {
  const match = text.match(/^Exit code (\d+)(?:\n|$)/);
  return match ? Number(match[1]) : undefined;
}

export function toDisplayPath(filePath: string, cwd?: string): string {
  if (typeof filePath !== "string") return displayValueOf(filePath) ?? "";
  if (!cwd) return filePath;
  const resolvedCwd = path.resolve(cwd);
  const resolvedFile = path.resolve(filePath);
  if (resolvedFile.startsWith(resolvedCwd + path.sep) || resolvedFile === resolvedCwd) {
    return path.relative(resolvedCwd, resolvedFile);
  }
  return filePath;
}

function pathOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function displayValueOf(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

function displayPathOf(value: unknown, cwd?: string): string | undefined {
  const filePath = pathOf(value);
  return filePath !== undefined ? toDisplayPath(filePath, cwd) : displayValueOf(value);
}

export function toolCallIdFor(
  toolUseId: string,
  sessionId: string,
  options: { namespaced?: boolean } = {},
): string {
  return options.namespaced ? `${sessionId}:${toolUseId}` : toolUseId;
}

interface RawToolUse {
  name: string;
  id: string;
  input?: unknown;
}

interface ReportFindingsInput {
  findings?: Array<{
    file: string;
    line?: number;
    summary: string;
  }>;
}

function normalizeWriteInput(input: unknown): FileWriteInput | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const filePath = raw.file_path ?? (typeof raw.path === "string" ? raw.path : undefined);
  const content = raw.content ?? raw.file_text ?? raw.file_content;
  return { ...raw, file_path: filePath, content } as FileWriteInput;
}

export function shellDescription(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  if (typeof raw.description === "string") return raw.description;
  return typeof raw.command_description === "string" ? raw.command_description : undefined;
}

export function grepPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  if (typeof raw.path === "string") return raw.path;
  return typeof raw.file_path === "string" ? raw.file_path : undefined;
}

function grepOutputMode(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  if (typeof raw.output_mode === "string") return raw.output_mode;
  if (raw["-l"] === true || raw["-l"] === "true") return "files_with_matches";
  if (raw["-c"] === true || raw["-c"] === "true") return "count";
  return undefined;
}

export function toolInfoFromToolUse(
  toolUse: RawToolUse,
  supportsTerminalOutput: boolean = false,
  cwd?: string,
): ToolInfo {
  const name = toolUse.name;

  switch (name) {
    case "Agent":
    case "Task": {
      const input = toolUse.input as AgentInput | BashInput | undefined;
      return {
        title: input?.description ? input.description : "Task",
        kind: "think",
        content:
          input && "prompt" in input
            ? [
                {
                  type: "content",
                  content: { type: "text", text: input.prompt },
                },
              ]
            : [],
      };
    }

    case "ReportFindings": {
      const input = toolUse.input as ReportFindingsInput | undefined;
      const findings = input?.findings ?? [];
      return {
        title:
          findings.length > 0
            ? `Report ${findings.length} finding${findings.length === 1 ? "" : "s"}`
            : "Report findings: none found",
        kind: "think",
        content: findings.map((f) => ({
          type: "content" as const,
          content: {
            type: "text" as const,
            text: `${f.file}${typeof f.line === "number" ? `:${f.line}` : ""} — ${f.summary}`,
          },
        })),
      };
    }

    case "Bash":
    case "PowerShell": {
      const input = toolUse.input as BashInput | undefined;
      const description = shellDescription(input);
      return {
        title: input?.command ? input.command : "Terminal",
        kind: "execute",
        content: supportsTerminalOutput
          ? [{ type: "terminal" as const, terminalId: toolUse.id }]
          : description
            ? [
                {
                  type: "content",
                  content: { type: "text", text: description },
                },
              ]
            : [],
      };
    }

    case "Read": {
      const input = toolUse.input as FileReadInput | undefined;
      let limit = "";
      if (input?.limit && input.limit > 0) {
        limit = " (" + (input.offset ?? 1) + " - " + ((input.offset ?? 1) + input.limit - 1) + ")";
      } else if (input?.offset) {
        limit = " (from line " + input.offset + ")";
      }
      const filePath = pathOf(input?.file_path);
      const displayPath = displayPathOf(input?.file_path, cwd) ?? "File";
      return {
        title: "Read " + displayPath + limit,
        kind: "read",
        locations: filePath
          ? [
              {
                path: filePath,
                line: input?.offset ?? 1,
              },
            ]
          : [],
        content: [],
      };
    }

    case "Write": {
      const input = normalizeWriteInput(toolUse.input);
      const filePath = pathOf(input?.file_path);
      let content: ToolCallContent[] = [];
      if (input && filePath) {
        content = [
          {
            type: "diff",
            path: filePath,
            oldText: null,
            newText: input.content,
          },
        ];
      } else if (input && input.content) {
        content = [
          {
            type: "content",
            content: { type: "text", text: input.content },
          },
        ];
      }
      const displayPath = displayPathOf(input?.file_path, cwd);
      return {
        title: displayPath ? `Write ${displayPath}` : "Write",
        kind: "edit",
        content,
        locations: filePath ? [{ path: filePath }] : [],
      };
    }

    case "NotebookEdit": {
      const input = toolUse.input as { notebook_path?: string } | undefined;
      const filePath = pathOf(input?.notebook_path);
      const displayPath = displayPathOf(input?.notebook_path, cwd);
      return {
        title: displayPath ? `Edit ${displayPath}` : "NotebookEdit",
        kind: "edit",
        content: [],
        locations: filePath ? [{ path: filePath }] : [],
      };
    }

    case "Edit": {
      const input = toolUse.input as FileEditInput | undefined;
      const filePath = pathOf(input?.file_path);
      let content: ToolCallContent[] = [];
      if (input && filePath && (input.old_string || input.new_string)) {
        content = [
          {
            type: "diff",
            path: filePath,
            oldText: input.old_string || null,
            newText: input.new_string ?? "",
          },
        ];
      }
      const displayPath = displayPathOf(input?.file_path, cwd);
      return {
        title: displayPath ? `Edit ${displayPath}` : "Edit",
        kind: "edit",
        content,
        locations: filePath ? [{ path: filePath }] : [],
      };
    }

    case "Glob": {
      const input = toolUse.input as GlobInput | undefined;
      const globPath = pathOf(input?.path);
      let label = "Find";
      if (input?.path) {
        label += ` \`${input.path}\``;
      }
      if (input?.pattern) {
        label += ` \`${input.pattern}\``;
      }
      return {
        title: label,
        kind: "search",
        content: [],
        locations: globPath ? [{ path: globPath }] : [],
      };
    }

    case "Grep": {
      const input = toolUse.input as GrepInput | undefined;
      let label = "grep";

      if (input?.["-i"]) {
        label += " -i";
      }
      if (input?.["-n"]) {
        label += " -n";
      }

      if (input?.["-A"] !== undefined) {
        label += ` -A ${input["-A"]}`;
      }
      if (input?.["-B"] !== undefined) {
        label += ` -B ${input["-B"]}`;
      }
      if (input?.["-C"] !== undefined) {
        label += ` -C ${input["-C"]}`;
      }

      const outputMode = grepOutputMode(input);
      if (outputMode) {
        switch (outputMode) {
          case "files_with_matches":
            label += " -l";
            break;
          case "count":
            label += " -c";
            break;
          case "content":
          default:
            break;
        }
      }

      if (input?.head_limit !== undefined) {
        label += ` | head -${input.head_limit}`;
      }

      if (input?.glob) {
        label += ` --include="${input.glob}"`;
      }

      if (input?.type) {
        label += ` --type=${input.type}`;
      }

      if (input?.multiline) {
        label += " -P";
      }

      if (input?.pattern) {
        label += ` "${input.pattern}"`;
      }

      const searchPath = grepPath(input);
      if (searchPath) {
        label += ` ${searchPath}`;
      }

      return {
        title: label,
        kind: "search",
        content: [],
      };
    }

    case "WebFetch": {
      const input = toolUse.input as WebFetchInput;
      return {
        title: input?.url ? `Fetch ${input.url}` : "Fetch",
        kind: "fetch",
        content:
          input && input.prompt
            ? [
                {
                  type: "content",
                  content: { type: "text", text: input.prompt },
                },
              ]
            : [],
      };
    }

    case "WebSearch": {
      const input = toolUse.input as WebSearchInput | undefined;
      let label = input?.query ? `"${input.query}"` : "Web search";

      if (input?.allowed_domains && input.allowed_domains.length > 0) {
        label += ` (allowed: ${input.allowed_domains.join(", ")})`;
      }

      if (input?.blocked_domains && input.blocked_domains.length > 0) {
        label += ` (blocked: ${input.blocked_domains.join(", ")})`;
      }

      return {
        title: label,
        kind: "fetch",
        content: [],
      };
    }

    case "TodoWrite": {
      const input = toolUse.input as TodoWriteInput | undefined;
      return {
        title: Array.isArray(input?.todos)
          ? `Update TODOs: ${input.todos.map((todo: TodoWriteInput["todos"][number]) => todo.content).join(", ")}`
          : "Update TODOs",
        kind: "think",
        content: [],
      };
    }

    case "TaskCreate": {
      const input = toolUse.input as TaskCreateInput | undefined;
      return {
        title: input?.subject ? `Create task: ${input.subject}` : "Create task",
        kind: "think",
        content: [],
      };
    }

    case "TaskUpdate": {
      const input = toolUse.input as TaskUpdateInput | undefined;
      return {
        title: input?.subject ? `Update task: ${input.subject}` : "Update task",
        kind: "think",
        content: [],
      };
    }

    case "TaskList": {
      return {
        title: "List tasks",
        kind: "think",
        content: [],
      };
    }

    case "TaskGet": {
      return {
        title: "Get task",
        kind: "think",
        content: [],
      };
    }

    case "ExitPlanMode": {
      const planInput = toolUse.input as { plan?: string } | undefined;
      return {
        title: "Ready to code?",
        kind: "switch_mode",
        content: planInput?.plan
          ? [{ type: "content" as const, content: { type: "text" as const, text: planInput.plan } }]
          : [],
      };
    }

    case "Skill": {
      const input = toolUse.input as { skill?: string } | undefined;
      const skillName = input?.skill;
      return {
        title: skillName ? `Load skill: ${skillName}` : "Load skill",
        kind: "other",
        content: [],
      };
    }

    case "Other": {
      const input = toolUse.input;
      let output;
      try {
        output = JSON.stringify(input, null, 2);
      } catch {
        output = typeof input === "string" ? input : "{}";
      }
      return {
        title: name || "Unknown Tool",
        kind: "other",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: `\`\`\`json\n${output}\`\`\``,
            },
          },
        ],
      };
    }

    default:
      return {
        title: name || "Unknown Tool",
        kind: "other",
        content: [],
      };
  }
}

function structuredResult<T extends object>(toolUseResult: unknown): T | undefined {
  return toolUseResult !== null &&
    typeof toolUseResult === "object" &&
    !Array.isArray(toolUseResult)
    ? (toolUseResult as T)
    : undefined;
}

function stripAgentTrailer(text: string): string {
  return stripAgentIdLine(stripUsageBlock(text));
}

const USAGE_OPEN = "<usage>";
const USAGE_CLOSE = "</usage>";

function stripUsageBlock(text: string): string {
  const body = text.trimEnd();
  if (!body.endsWith(USAGE_CLOSE)) {
    return text;
  }
  const open = body.lastIndexOf(USAGE_OPEN, body.length - USAGE_CLOSE.length - USAGE_OPEN.length);
  if (open === -1) {
    return text;
  }
  return body.slice(0, open > 0 && body[open - 1] === "\n" ? open - 1 : open);
}

const AGENT_ID_LINE = /^agentId: [\w-]+ \([^)]*\)$/;

function stripAgentIdLine(text: string): string {
  const body = text.trimEnd();
  const lineStart = body.lastIndexOf("\n") + 1;
  if (!AGENT_ID_LINE.test(body.slice(lineStart))) {
    return text;
  }
  return body.slice(0, Math.max(lineStart - 1, 0));
}

function stripAgentTrailerFromContent(content: unknown): unknown {
  if (typeof content === "string") {
    return stripAgentTrailer(content);
  }
  if (Array.isArray(content)) {
    return content.map((block: unknown) =>
      block !== null &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
        ? { ...block, text: stripAgentTrailer((block as { text: string }).text) }
        : block,
    );
  }
  return content;
}

export function toolUpdateFromToolResult(
  toolResult:
    | ToolResultBlockParam
    | BetaToolResultBlockParam
    | BetaWebSearchToolResultBlockParam
    | BetaWebFetchToolResultBlockParam
    | WebSearchToolResultBlockParam
    | BetaCodeExecutionToolResultBlockParam
    | BetaBashCodeExecutionToolResultBlockParam
    | BetaTextEditorCodeExecutionToolResultBlockParam
    | BetaRequestMCPToolResultBlockParam
    | BetaToolSearchToolResultBlockParam,
  toolUse: { name?: string; id?: string; input?: unknown } | undefined,
  supportsTerminalOutput: boolean = false,
  toolUseResult?: unknown,
  background?: BackgroundExitPolicy,
): ToolUpdate {
  if (
    "is_error" in toolResult &&
    toolResult.is_error &&
    toolResult.content &&
    toolResult.content.length > 0 &&
    !(toolUse?.name === "Bash" && supportsTerminalOutput)
  ) {
    return toAcpContentUpdate(toolResult.content, true);
  }

  const rawContentUpdate = () =>
    toAcpContentUpdate(toolResult.content, "is_error" in toolResult ? toolResult.is_error : false);

  switch (toolUse?.name) {
    case "Read": {
      const structuredRead = structuredResult<FileReadOutput>(toolUseResult);
      if (
        structuredRead?.type === "image" &&
        typeof structuredRead.file?.base64 === "string" &&
        structuredRead.file.base64.length > 0 &&
        typeof structuredRead.file.type === "string"
      ) {
        return {
          content: [
            {
              type: "content",
              content: {
                type: "image",
                data: structuredRead.file.base64,
                mimeType: structuredRead.file.type,
              },
            },
          ],
        };
      }
      if (
        structuredRead?.type === "text" &&
        typeof structuredRead.file?.content === "string" &&
        structuredRead.file.content.length > 0
      ) {
        const startLine =
          structuredRead.file.startLine ??
          (toolUse?.input as FileReadInput | undefined)?.offset ??
          1;
        let numbered = structuredRead.file.content
          .replace(/\n$/, "")
          .split("\n")
          .map((line, i) => `${startLine + i}\t${line}`)
          .join("\n");
        if (structuredRead.file.truncatedByTokenCap) {
          const { numLines, totalLines } = structuredRead.file;
          const detail =
            typeof numLines === "number" && typeof totalLines === "number"
              ? `: showing ${numLines} of ${totalLines} lines`
              : "";
          numbered += `\n[File truncated${detail}]`;
        }
        return {
          content: [
            {
              type: "content",
              content: { type: "text", text: markdownEscape(numbered) },
            },
          ],
        };
      }
      if (Array.isArray(toolResult.content) && toolResult.content.length > 0) {
        return {
          content: toolResult.content.map((content: unknown) => ({
            type: "content",
            content:
              (content as { type?: string }).type === "text"
                ? {
                    type: "text",
                    text: markdownEscape((content as { text: string }).text),
                  }
                : toAcpContentBlock(content as ToolResultContent, false),
          })),
        };
      } else if (typeof toolResult.content === "string" && toolResult.content.length > 0) {
        return {
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: markdownEscape(toolResult.content),
              },
            },
          ],
        };
      }
      return {};
    }

    case "Bash": {
      const result = toolResult.content;
      const terminalIdOf = (id: unknown): string | undefined =>
        typeof id === "string" && id.length > 0 ? id : undefined;
      const terminalId: string | undefined =
        terminalIdOf(toolUse?.id) ??
        terminalIdOf("tool_use_id" in toolResult ? toolResult.tool_use_id : undefined);
      const isError = "is_error" in toolResult && toolResult.is_error;

      let output = "";
      let exitCode: number | null = isError ? 1 : 0;

      const structuredBash = structuredResult<BashOutput>(toolUseResult);
      if (
        structuredBash &&
        typeof structuredBash.stdout === "string" &&
        typeof structuredBash.stderr === "string" &&
        !structuredBash.isImage &&
        structuredBash.backgroundTaskId === undefined
      ) {
        output = [structuredBash.stdout, structuredBash.stderr].filter(Boolean).join("\n");
        if (structuredBash.interrupted) {
          output = [output, "[Command was aborted before completion]"].filter(Boolean).join("\n");
          exitCode = 1;
        }
        if (typeof structuredBash.persistedOutputPath === "string") {
          const size =
            typeof structuredBash.persistedOutputSize === "number"
              ? ` (${structuredBash.persistedOutputSize} bytes total)`
              : "";
          output = [
            output,
            `[Output truncated${size}: full output saved to ${structuredBash.persistedOutputPath}]`,
          ]
            .filter(Boolean)
            .join("\n");
        }
      } else if (
        result &&
        typeof result === "object" &&
        "type" in result &&
        result.type === "bash_code_execution_result"
      ) {
        const bashResult = result as BetaBashCodeExecutionResultBlock;
        output = [bashResult.stdout, bashResult.stderr].filter(Boolean).join("\n");
        exitCode = bashResult.return_code;
      } else if (typeof result === "string") {
        output = result;
      } else if (
        Array.isArray(result) &&
        result.length > 0 &&
        "text" in result[0] &&
        typeof result[0].text === "string"
      ) {
        output = result.map((c: unknown) => (c as { text: string }).text).join("\n");
      }

      if (isError) {
        const named = failureExitCode(output);
        if (named !== undefined && named !== 0) exitCode = named;
      }

      const backgroundTaskId = structuredBash?.backgroundTaskId;
      let holdExit = false;
      if (backgroundTaskId !== undefined && !isError) {
        const end = terminalId !== undefined ? background?.ended(terminalId) : undefined;
        if (end) exitCode = end.exitCode;
        else if (background?.holdRunning) holdExit = true;
        else exitCode = null;
      }

      if (supportsTerminalOutput && terminalId !== undefined) {
        return {
          content: [{ type: "terminal" as const, terminalId }],
          _meta: {
            terminal_info: {
              terminal_id: terminalId,
            },
            terminal_output: {
              terminal_id: terminalId,
              data: output,
            },
            ...(holdExit
              ? {}
              : {
                  terminal_exit: {
                    terminal_id: terminalId,
                    exit_code: exitCode,
                    signal: null,
                  },
                }),
          },
        };
      }
      if (output.trim()) {
        return {
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: `\`\`\`console\n${output.trimEnd()}\n\`\`\``,
              },
            },
          ],
        };
      }
      return {};
    }

    case "Skill": {
      return {};
    }

    case "Edit":
    case "Write": {
      return {};
    }

    case "ExitPlanMode": {
      return { title: "Exited Plan Mode" };
    }

    case "Agent":
    case "Task": {
      const structuredAgent = structuredResult<AgentOutput>(toolUseResult);
      if (
        structuredAgent?.status === "completed" &&
        Array.isArray(structuredAgent.content) &&
        structuredAgent.content.length > 0
      ) {
        return toAcpContentUpdate(
          structuredAgent.content,
          "is_error" in toolResult ? toolResult.is_error : false,
        );
      }
      return toAcpContentUpdate(
        stripAgentTrailerFromContent(toolResult.content),
        "is_error" in toolResult ? toolResult.is_error : false,
      );
    }

    case "WebSearch": {
      const structuredSearch = structuredResult<WebSearchOutput>(toolUseResult);
      if (structuredSearch && Array.isArray(structuredSearch.results)) {
        const lines = structuredSearch.results.flatMap((entry) =>
          typeof entry === "string"
            ? [entry]
            : Array.isArray(entry?.content)
              ?
                entry.content.flatMap((hit) =>
                  typeof hit?.title === "string" && typeof hit?.url === "string"
                    ? [formatWebSearchHit(hit)]
                    : [],
                )
              : [],
        );
        if (lines.length > 0) {
          return {
            content: [
              {
                type: "content",
                content: { type: "text", text: lines.join("\n") },
              },
            ],
          };
        }
      }
      return rawContentUpdate();
    }

    default: {
      return rawContentUpdate();
    }
  }
}

function formatWebSearchHit(hit: { title: string; url: string }): string {
  return `${hit.title} (${hit.url})`;
}

function toAcpContentUpdate(
  content: unknown,
  isError: boolean = false,
): { content?: ToolCallContent[] } {
  if (Array.isArray(content) && content.length > 0) {
    return {
      content: content.map((c: unknown) => ({
        type: "content" as const,
        content: toAcpContentBlock(c as ToolResultContent, isError),
      })),
    };
  } else if (typeof content === "object" && content !== null && "type" in content) {
    return {
      content: [
        {
          type: "content" as const,
          content: toAcpContentBlock(content as ToolResultContent, isError),
        },
      ],
    };
  } else if (typeof content === "string" && content.length > 0) {
    return {
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: isError ? `\`\`\`\n${content}\n\`\`\`` : content,
          },
        },
      ],
    };
  }
  return {};
}

function toAcpContentBlock(content: ToolResultContent, isError: boolean): ContentBlock {
  const wrapText = (text: string): ContentBlock => ({
    type: "text" as const,
    text: isError ? `\`\`\`\n${text}\n\`\`\`` : text,
  });

  switch (content.type) {
    case "text":
      return {
        type: "text" as const,
        text: isError ? `\`\`\`\n${content.text}\n\`\`\`` : content.text,
      };
    case "image":
      if (content.source.type === "base64") {
        return {
          type: "image" as const,
          data: content.source.data,
          mimeType: content.source.media_type,
        };
      }
      return wrapText(
        content.source.type === "url"
          ? `[image: ${content.source.url}]`
          : "[image: file reference]",
      );

    case "tool_reference":
      return wrapText(`Tool: ${content.tool_name}`);
    case "tool_search_tool_search_result":
      return wrapText(
        `Tools found: ${content.tool_references.map((r) => r.tool_name).join(", ") || "none"}`,
      );
    case "tool_search_tool_result_error":
      return wrapText(
        `Error: ${content.error_code}${content.error_message ? ` - ${content.error_message}` : ""}`,
      );
    case "web_search_result":
      return wrapText(formatWebSearchHit(content));
    case "web_search_tool_result_error":
      return wrapText(`Error: ${content.error_code}`);
    case "web_fetch_result":
      return wrapText(`Fetched: ${content.url}`);
    case "web_fetch_tool_result_error":
      return wrapText(`Error: ${content.error_code}`);
    case "code_execution_result":
      return wrapText(`Output: ${content.stdout || content.stderr || ""}`);
    case "bash_code_execution_result":
      return wrapText(`Output: ${content.stdout || content.stderr || ""}`);
    case "code_execution_tool_result_error":
    case "bash_code_execution_tool_result_error":
      return wrapText(`Error: ${content.error_code}`);
    case "text_editor_code_execution_view_result":
      return wrapText(content.content);
    case "text_editor_code_execution_create_result":
      return wrapText(content.is_file_update ? "File updated" : "File created");
    case "text_editor_code_execution_str_replace_result":
      return wrapText(content.lines?.join("\n") || "");
    case "text_editor_code_execution_tool_result_error":
      return wrapText(
        `Error: ${content.error_code}${content.error_message ? ` - ${content.error_message}` : ""}`,
      );

    default:
      return wrapText(JSON.stringify(content));
  }
}

export type ClaudePlanEntry = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
};

export function planEntries(input: { todos: ClaudePlanEntry[] } | undefined): PlanEntry[] {
  return (input?.todos ?? []).map((todo) => ({
    content: todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content,
    status: todo.status,
    priority: "medium",
  }));
}

export type TaskEntry = {
  subject: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
  description?: string;
};
export type TaskState = Map<string, TaskEntry>;

function toolOutputTexts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    block &&
    typeof block === "object" &&
    "type" in block &&
    block.type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
      ? [(block as { text: string }).text]
      : [],
  );
}

function parseJsonToolOutput<T>(
  content: unknown,
  isValid: (parsed: unknown) => boolean,
): T | undefined {
  if (content && typeof content === "object" && !Array.isArray(content) && isValid(content)) {
    return content as T;
  }
  for (const text of toolOutputTexts(content)) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isValid(parsed)) return parsed as T;
    } catch {
    }
  }
  return undefined;
}

export function parseTaskCreateOutput(content: unknown): TaskCreateOutput | undefined {
  const structured = parseJsonToolOutput<TaskCreateOutput>(
    content,
    (parsed) =>
      Boolean(parsed) &&
      typeof parsed === "object" &&
      "task" in (parsed as object) &&
      typeof (parsed as TaskCreateOutput).task?.id === "string",
  );
  if (structured) return structured;

  for (const text of toolOutputTexts(content)) {
    const match = /^Task #(\S+) created successfully: (.+)$/.exec(text.trim());
    if (match) return { task: { id: match[1], subject: match[2] } } as TaskCreateOutput;
  }
  return undefined;
}

const TASK_STATUSES = new Set(["pending", "in_progress", "completed"]);

function parseTaskListLine(line: string): TaskListOutput["tasks"][number] | undefined {
  if (!line.startsWith("#")) return undefined;
  const idEnd = line.indexOf(" ");
  if (idEnd < 2) return undefined;
  const id = line.slice(1, idEnd);

  const afterId = line.slice(idEnd + 1);
  if (!afterId.startsWith("[")) return undefined;
  const statusEnd = afterId.indexOf("]");
  if (statusEnd < 0) return undefined;
  const status = afterId.slice(1, statusEnd);
  if (!TASK_STATUSES.has(status)) return undefined;

  let tail = afterId.slice(statusEnd + 1);
  if (!tail.startsWith(" ")) return undefined;
  tail = tail.slice(1);

  let blockedBy: string[] = [];
  const BLOCKED_BY = " [blocked by ";
  if (tail.endsWith("]")) {
    const at = tail.lastIndexOf(BLOCKED_BY);
    if (at > 0) {
      const entries = tail.slice(at + BLOCKED_BY.length, -1).split(", ");
      if (
        entries.length > 0 &&
        entries.every(
          (entry) =>
            entry.startsWith("#") &&
            entry.length > 1 &&
            !entry.includes(",") &&
            !entry.includes("]"),
        )
      ) {
        blockedBy = entries.map((entry) => entry.slice(1));
        tail = tail.slice(0, at);
      }
    }
  }

  let owner: string | undefined;
  if (tail.endsWith(")")) {
    const at = tail.lastIndexOf(" (");
    if (at > 0) {
      const inner = tail.slice(at + 2, -1);
      if (!inner.includes("(") && !inner.includes(")")) {
        owner = inner;
        tail = tail.slice(0, at);
      }
    }
  }

  if (tail.length === 0) return undefined;
  return {
    id,
    subject: tail,
    status: status as TaskListOutput["tasks"][number]["status"],
    ...(owner ? { owner } : {}),
    blockedBy,
  };
}

export function parseTaskListOutput(content: unknown): TaskListOutput | undefined {
  const structured = parseJsonToolOutput<TaskListOutput>(
    content,
    (parsed) =>
      Boolean(parsed) &&
      typeof parsed === "object" &&
      Array.isArray((parsed as TaskListOutput).tasks) &&
      (parsed as TaskListOutput).tasks.every(
        (task) =>
          Boolean(task) &&
          typeof task.id === "string" &&
          typeof task.subject === "string" &&
          TASK_STATUSES.has(task.status),
      ),
  );
  if (structured) return structured;

  for (const text of toolOutputTexts(content)) {
    if (text.trim() === "No tasks found") return { tasks: [] };
    const tasks: TaskListOutput["tasks"] = [];
    let clean = true;
    for (const line of text.trim().split("\n")) {
      const task = parseTaskListLine(line);
      if (!task) {
        clean = false;
        break;
      }
      tasks.push(task);
    }
    if (clean && tasks.length > 0) return { tasks };
  }
  return undefined;
}

export function parseTaskUpdateOutput(
  content: unknown,
  expectedTaskId?: string,
): TaskUpdateOutput | undefined {
  const structured = parseJsonToolOutput<TaskUpdateOutput>(
    content,
    (parsed) =>
      Boolean(parsed) &&
      typeof parsed === "object" &&
      typeof (parsed as TaskUpdateOutput).success === "boolean" &&
      typeof (parsed as TaskUpdateOutput).taskId === "string" &&
      Array.isArray((parsed as TaskUpdateOutput).updatedFields),
  );
  if (structured) return structured;

  for (const text of toolOutputTexts(content)) {
    const notFound = /^Task #(\S+) not found$/.exec(text.trim());
    const taskId = notFound?.[1] ?? expectedTaskId;
    if (taskId && (notFound || text.trim() === "Failed to delete task")) {
      return { success: false, taskId, updatedFields: [], error: text.trim() };
    }
  }
  return undefined;
}

export function applyTaskCreate(
  state: TaskState,
  input: TaskCreateInput | undefined,
  output: TaskCreateOutput | undefined,
): void {
  const taskId = output?.task?.id;
  if (!taskId || !input) return;
  state.set(taskId, {
    subject: input.subject,
    status: "pending",
    activeForm: input.activeForm,
    description: input.description,
  });
}

export function applyTaskUpdate(state: TaskState, input: TaskUpdateInput | undefined): void {
  if (!input?.taskId) return;
  if (input.status === "deleted") {
    state.delete(input.taskId);
    return;
  }
  const existing = state.get(input.taskId);
  const subject = input.subject ?? existing?.subject;
  if (!subject) return;
  state.set(input.taskId, {
    subject,
    status: input.status ?? existing?.status ?? "pending",
    activeForm: input.activeForm ?? existing?.activeForm,
    description: input.description ?? existing?.description,
  });
}

export function applyTaskList(state: TaskState, output: TaskListOutput): void {
  const previous = new Map(state);
  state.clear();
  for (const task of output.tasks) {
    const existing = previous.get(task.id);
    state.set(task.id, {
      subject: task.subject,
      status: task.status,
      activeForm: existing?.activeForm,
      description: existing?.description,
    });
  }
}

export function taskStateToPlanEntries(state: TaskState): PlanEntry[] {
  return Array.from(state.values()).map((task) => ({
    content: task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject,
    status: task.status,
    priority: "medium",
  }));
}

export function markdownEscape(text: string): string {
  let escape = "```";
  for (const [m] of text.matchAll(/^```+/gm)) {
    while (m.length >= escape.length) {
      escape += "`";
    }
  }
  return escape + "\n" + text + (text.endsWith("\n") ? "" : "\n") + escape;
}

interface DiffToolResponseHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

interface DiffToolResponse {
  filePath?: string;
  structuredPatch?: DiffToolResponseHunk[];
}

export function toolUpdateFromDiffToolResponse(toolResponse: unknown): {
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
} {
  if (!toolResponse || typeof toolResponse !== "object") return {};
  const response = toolResponse as DiffToolResponse;
  if (!response.filePath || !Array.isArray(response.structuredPatch)) return {};

  const content: ToolCallContent[] = [];
  const locations: ToolCallLocation[] = [];

  for (const { lines, newStart } of response.structuredPatch) {
    const oldText: string[] = [];
    const newText: string[] = [];
    for (const line of lines) {
      if (line.startsWith("-")) {
        oldText.push(line.slice(1));
      } else if (line.startsWith("+")) {
        newText.push(line.slice(1));
      } else {
        oldText.push(line.slice(1));
        newText.push(line.slice(1));
      }
    }
    if (oldText.length > 0 || newText.length > 0) {
      locations.push({ path: response.filePath, line: newStart });
      content.push({
        type: "diff",
        path: response.filePath,
        oldText: oldText.join("\n") || null,
        newText: newText.join("\n"),
      });
    }
  }

  const result: { content?: ToolCallContent[]; locations?: ToolCallLocation[] } = {};
  if (content.length > 0) result.content = content;
  if (locations.length > 0) result.locations = locations;
  return result;
}

const toolUseCallbacks: {
  [toolUseId: string]: {
    onPostToolUseHook?: (
      toolUseID: string,
      toolInput: unknown,
      toolResponse: unknown,
    ) => Promise<void>;
  };
} = {};

export const registerHookCallback = (
  toolUseID: string,
  {
    onPostToolUseHook,
  }: {
    onPostToolUseHook?: (
      toolUseID: string,
      toolInput: unknown,
      toolResponse: unknown,
    ) => Promise<void>;
  },
) => {
  toolUseCallbacks[toolUseID] = {
    onPostToolUseHook,
  };
};

export const createPostToolUseHook =
  (
    logger: Logger = console,
    options?: {
      onEnterPlanMode?: () => Promise<void>;
    },
  ): HookCallback =>
  async (input, toolUseID: string | undefined): Promise<{ continue: boolean }> => {
    if (input.hook_event_name === "PostToolUse") {
      if (input.tool_name === "EnterPlanMode" && options?.onEnterPlanMode) {
        await options.onEnterPlanMode();
      }

      if (toolUseID) {
        const onPostToolUseHook = toolUseCallbacks[toolUseID]?.onPostToolUseHook;
        if (onPostToolUseHook) {
          await onPostToolUseHook(toolUseID, input.tool_input, input.tool_response);
          delete toolUseCallbacks[toolUseID];
        } else {
          logger.error(`No onPostToolUseHook found for tool use ID: ${toolUseID}`);
          delete toolUseCallbacks[toolUseID];
        }
      }
    }
    return { continue: true };
  };

export const createTaskHook =
  (options: { taskState: TaskState; onChange?: () => Promise<void> }): HookCallback =>
  async (input): Promise<{ continue: boolean }> => {
    const taskId =
      "task_id" in input && typeof input.task_id === "string" ? input.task_id : undefined;
    if (!taskId) return { continue: true };

    if (input.hook_event_name === "TaskCreated") {
      if (!input.task_subject) return { continue: true };
      if (options.taskState.has(taskId)) return { continue: true };
      options.taskState.set(taskId, {
        subject: input.task_subject,
        status: "pending",
        description: input.task_description,
      });
      if (options.onChange) await options.onChange();
    } else if (input.hook_event_name === "TaskCompleted") {
      const existing = options.taskState.get(taskId);
      if (!existing || existing.status === "completed") return { continue: true };
      options.taskState.set(taskId, { ...existing, status: "completed" });
      if (options.onChange) await options.onChange();
    }
    return { continue: true };
  };
