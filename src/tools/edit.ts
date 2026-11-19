import type { FileEditOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { asBool, asString, mapWritePath } from "./paths.js";
import { structuredPatch } from "./patch.js";

const EDIT_DIFF_BYTE_CAP = 512 * 1024;
/** Cap oldString and newString echoes so combined JSON stays comfortably under Mods' ~4 MiB join limit. */
const EDIT_ECHO_BYTE_CAP = 750_000;

function capUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) {
    end = Math.max(0, end - 1024);
  }
  return `${text.slice(0, end)}\n… [truncated in tool result]`;
}

export async function editTool(cwd: string, tuiRoot: string | undefined, input: Record<string, unknown>, extraDirs: string[] = [], project?: string): Promise<FileEditOutput> {
  const path = mapWritePath(cwd, tuiRoot, asString(input.file_path), extraDirs, project);
  const oldString = asString(input.old_string);
  const newString = asString(input.new_string);
  const replaceAll = asBool(input.replace_all) === true;
  if (oldString === newString) throw new Error("No changes to make: old_string and new_string are exactly the same.");

  const existed = await Bun.file(path).exists();
  if (!existed) {
    if (oldString !== "") throw new Error(`File does not exist: ${path}`);
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, newString);
    const keepDiff = Buffer.byteLength(newString, "utf8") <= EDIT_DIFF_BYTE_CAP;
    return {
      filePath: path,
      oldString,
      newString: capUtf8(newString, EDIT_ECHO_BYTE_CAP),
      originalFile: null,
      structuredPatch: keepDiff ? structuredPatch("", newString) : [],
      userModified: false,
      replaceAll,
    };
  }
  if (oldString === "") throw new Error("Cannot create new file - file already exists.");

  const originalFile = await Bun.file(path).text();
  let matchOld = oldString;
  let matchNew = newString;
  let parts = originalFile.split(matchOld);
  if (parts.length - 1 === 0 && originalFile.includes("\r\n") && !oldString.includes("\r\n")) {
    const crlfOld = oldString.replaceAll("\n", "\r\n");
    const crlfParts = originalFile.split(crlfOld);
    if (crlfParts.length - 1 > 0) {
      matchOld = crlfOld;
      matchNew = newString.includes("\r\n") ? newString : newString.replaceAll("\n", "\r\n");
      parts = crlfParts;
    }
  }
  const matches = parts.length - 1;
  if (matches === 0) throw new Error(`String to replace not found in file.\nString: ${oldString}`);
  if (matches > 1 && !replaceAll) {
    throw new Error(
      `Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldString}`,
    );
  }
  const next = replaceAll ? parts.join(matchNew) : parts[0] + matchNew + parts.slice(1).join(matchOld);
  await Bun.write(path, next);
  const keepDiff = Buffer.byteLength(originalFile, "utf8") + Buffer.byteLength(next, "utf8") <= EDIT_DIFF_BYTE_CAP;
  return {
    filePath: path,
    oldString: capUtf8(oldString, EDIT_ECHO_BYTE_CAP),
    newString: capUtf8(newString, EDIT_ECHO_BYTE_CAP),
    originalFile: keepDiff ? originalFile : null,
    structuredPatch: keepDiff ? structuredPatch(originalFile, next) : [],
    userModified: false,
    replaceAll,
  };
}
