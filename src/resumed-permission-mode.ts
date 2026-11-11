import { open } from "node:fs/promises";

const TAIL_CHUNK_BYTES = 64 * 1024;

type TranscriptRecord = {
  type?: unknown;
  isSidechain?: unknown;
  permissionMode?: unknown;
  origin?: { kind?: unknown };
  attachment?: { type?: unknown };
};

class PermissionModeScan {
  mode: string | undefined;
  private planExited = false;

  visit(line: Buffer): boolean {
    let parsed: TranscriptRecord | null | undefined;
    const record = (marker: string): TranscriptRecord | undefined => {
      if (line.indexOf(marker) < 0) return undefined;
      if (parsed === undefined) parsed = parseMainThreadRecord(line);
      return parsed ?? undefined;
    };
    const modeEntry = record('"permissionMode"');
    if (
      (modeEntry?.type === "user" || modeEntry?.type === "permission-mode") &&
      typeof modeEntry.permissionMode === "string" &&
      modeEntry.permissionMode.trim() !== ""
    ) {
      const mode = modeEntry.permissionMode.trim();
      if (!(this.planExited && mode === "plan")) this.mode = mode;
      return true;
    }
    if (record('"plan_mode_exit"')?.attachment?.type === "plan_mode_exit") {
      this.planExited = true;
      return false;
    }
    const human = record('"human"');
    return human?.type === "user" && human.origin?.kind === "human";
  }
}

function parseMainThreadRecord(line: Buffer): TranscriptRecord | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line.toString("utf8"));
  } catch {
    return null;
  }
  if (!entry || typeof entry !== "object") return null;
  const record = entry as TranscriptRecord;
  return record.isSidechain === true ? null : record;
}

export async function readTranscriptPermissionMode(filePath: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch {
    return undefined;
  }
  const scan = new PermissionModeScan();
  try {
    let end = (await handle.stat()).size;
    let pending: Buffer[] = [];
    while (end > 0) {
      const start = Math.max(0, end - TAIL_CHUNK_BYTES);
      let chunk = Buffer.alloc(end - start);
      await handle.read(chunk, 0, chunk.length, start);
      for (let at = chunk.lastIndexOf(0x0a); at >= 0; at = chunk.lastIndexOf(0x0a)) {
        if (scan.visit(Buffer.concat([chunk.subarray(at + 1), ...pending]))) return scan.mode;
        pending = [];
        chunk = chunk.subarray(0, at);
      }
      pending.unshift(chunk);
      end = start;
    }
    scan.visit(Buffer.concat(pending));
    return scan.mode;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}
