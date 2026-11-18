import type { FileWriteOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { asString, mapWritePath } from "./paths.js";
import { structuredPatch } from "./patch.js";

const WRITE_DIFF_BYTE_CAP = 512 * 1024;
const WRITE_ECHO_BYTE_CAP = 1_500_000;

function capUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) {
    end = Math.max(0, end - 1024);
  }
  return `${text.slice(0, end)}\n… [truncated in tool result]`;
}

export async function writeTool(cwd: string, tuiRoot: string | undefined, input: Record<string, unknown>, extraDirs: string[] = [], project?: string): Promise<FileWriteOutput> {
  const path = mapWritePath(cwd, tuiRoot, asString(input.file_path), extraDirs, project);
  const content = asString(input.content);
  const file = Bun.file(path);
  const existed = await file.exists();
  const prevSize = existed ? (await file.stat().catch(() => ({ size: 0 }))).size : 0;
  const contentBytes = Buffer.byteLength(content, "utf8");
  const keepDiff = (!existed || prevSize <= WRITE_DIFF_BYTE_CAP) && prevSize + contentBytes <= WRITE_DIFF_BYTE_CAP;
  const originalFile = existed && prevSize <= WRITE_DIFF_BYTE_CAP ? await file.text() : null;
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, content);
  return {
    type: existed ? "update" as const : "create" as const,
    filePath: path,
    content: capUtf8(content, WRITE_ECHO_BYTE_CAP),
    structuredPatch: keepDiff ? structuredPatch(originalFile ?? "", content) : [],
    originalFile: keepDiff ? originalFile : null,
  };
}
