import type { ToolCallContent } from "@agentclientprotocol/sdk/unstable";
import { toolUpdateFromDiffToolResponse } from "./tools.js";

export interface Hunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

export type DiffSource =
  | { readonly kind: "not-a-diff-source" }
  | {
      readonly kind: "edit";
      readonly filePath: string;
      readonly originalFile: string;
      readonly structuredPatch: readonly Hunk[];
    }
  | { readonly kind: "write"; readonly filePath: string; readonly content: string }
  | { readonly kind: "unsupported"; readonly tool?: string };

export interface DiffToolResponseInput {
  readonly filePath: string;
  readonly structuredPatch: readonly Hunk[];
}

const NOT_A_DIFF_SOURCE: DiffSource = { kind: "not-a-diff-source" };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

const DIFF_BEARING_NAMES: ReadonlySet<string> = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

function isDiffBearingName(name: string | undefined): boolean {
  return name !== undefined && (DIFF_BEARING_NAMES.has(name) || name.startsWith("mcp__"));
}

function skipAndLog(name: string | undefined, reason: string): DiffSource {
  console.error(`[diff-source] skipping ${name ?? "<unknown tool>"}: ${reason}`);
  return { kind: "unsupported", tool: name };
}

export function classifyDiffSource(name: string | undefined, toolUseResult: unknown): DiffSource {
  if (!isObject(toolUseResult)) {
    return NOT_A_DIFF_SOURCE;
  }

  const structuredPatch = toolUseResult.structuredPatch;
  const hasStructuredPatch = Array.isArray(structuredPatch);
  const hasContent = "content" in toolUseResult;
  const hasOriginalFile = "originalFile" in toolUseResult;

  if (!hasStructuredPatch && !hasContent && !hasOriginalFile) {
    return isDiffBearingName(name)
      ? skipAndLog(
          name,
          "diff-bearing tool produced no usable structuredPatch/originalFile/content",
        )
      : NOT_A_DIFF_SOURCE;
  }

  const filePath = toolUseResult.filePath;
  const originalFile = toolUseResult.originalFile;
  const content = toolUseResult.content;

  const looksLikeEdit =
    name === "Edit" || (hasStructuredPatch && structuredPatch.length > 0 && isString(originalFile));
  if (looksLikeEdit) {
    if (!isString(filePath) || !isString(originalFile) || !hasStructuredPatch) {
      return skipAndLog(name, "Edit is missing filePath, originalFile, or structuredPatch");
    }
    return { kind: "edit", filePath, originalFile, structuredPatch: structuredPatch as Hunk[] };
  }

  const looksLikeWrite =
    name === "Write" || (hasStructuredPatch && structuredPatch.length === 0 && isString(content));
  if (looksLikeWrite) {
    if (!isString(filePath) || !isString(content)) {
      return skipAndLog(name, "Write is missing filePath or content");
    }
    return { kind: "write", filePath, content };
  }

  return skipAndLog(name, "diff-bearing payload of an unverified shape");
}

function syntheticAdditionHunk(content: string): Hunk {
  const lines = content.split("\n");
  return {
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: lines.length,
    lines: lines.map((line) => "+" + line),
  };
}

export function toDiffToolResponse(source: DiffSource): DiffToolResponseInput | null {
  switch (source.kind) {
    case "edit":
      return { filePath: source.filePath, structuredPatch: source.structuredPatch };
    case "write":
      return {
        filePath: source.filePath,
        structuredPatch: [syntheticAdditionHunk(source.content)],
      };
    case "unsupported":
    case "not-a-diff-source":
      return null;
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

export interface DiffToolCallUpdate {
  readonly sessionUpdate: "tool_call_update";
  readonly toolCallId: string;
  readonly content: ToolCallContent[];
}

export function diffToolCallUpdate(
  source: DiffSource,
  toolCallId: string,
): DiffToolCallUpdate | null {
  const input = toDiffToolResponse(source);
  if (input === null) {
    return null;
  }
  const { content } = toolUpdateFromDiffToolResponse(input);
  if (content === undefined || content.length === 0) {
    return null;
  }
  return { sessionUpdate: "tool_call_update", toolCallId, content };
}
