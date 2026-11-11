import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { asBool, asString, mapPath } from "./paths.js";
import { structuredPatch } from "./patch.js";

export async function editTool(cwd: string, tuiRoot: string | undefined, input: Record<string, unknown>, extraDirs: string[] = []) {
  const path = mapPath(cwd, tuiRoot, asString(input.file_path), extraDirs);
  const oldString = asString(input.old_string);
  const newString = asString(input.new_string);
  const replaceAll = asBool(input.replace_all) === true;
  if (oldString === newString) throw new Error("No changes to make: old_string and new_string are exactly the same.");

  const existed = await Bun.file(path).exists();
  if (!existed) {
    if (oldString !== "") throw new Error(`File does not exist: ${path}`);
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, newString);
    return {
      filePath: path,
      oldString,
      newString,
      originalFile: null,
      structuredPatch: structuredPatch("", newString),
      userModified: false,
      replaceAll,
    };
  }
  if (oldString === "") throw new Error("Cannot create new file - file already exists.");

  const originalFile = await Bun.file(path).text();
  const parts = originalFile.split(oldString);
  const matches = parts.length - 1;
  if (matches === 0) throw new Error(`String to replace not found in file.\nString: ${oldString}`);
  if (matches > 1 && !replaceAll) {
    throw new Error(
      `Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldString}`,
    );
  }
  const next = replaceAll ? parts.join(newString) : parts[0] + newString + parts.slice(1).join(oldString);
  await Bun.write(path, next);
  return {
    filePath: path,
    oldString,
    newString,
    originalFile,
    structuredPatch: structuredPatch(originalFile, next),
    userModified: false,
    replaceAll,
  };
}
