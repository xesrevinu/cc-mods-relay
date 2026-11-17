import { open } from "node:fs/promises";

const TAIL_CHUNK_BYTES = 64 * 1024;

type TranscriptRecord = {
  type?: unknown;
  isSidechain?: unknown;
  permissionMode?: unknown;
  origin?: { kind?: unknown };
  attachment?: { type?: unknown };
  message?: { model?: unknown };
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

class ModelScan {
  model: string | undefined;

  visit(line: Buffer): boolean {
    if (line.indexOf('"assistant"') < 0 || line.indexOf('"model"') < 0) return false;
    const record = parseMainThreadRecord(line);
    if (record?.type !== "assistant") return false;
    const model = record.message?.model;
    if (typeof model !== "string" || model.trim() === "") return false;
    this.model = model.trim();
    return true;
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

async function scanTranscriptTail(
  filePath: string,
  visit: (line: Buffer) => boolean,
  done: () => string | undefined,
): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch {
    return undefined;
  }
  try {
    let end = (await handle.stat()).size;
    let pending: Buffer[] = [];
    while (end > 0) {
      const start = Math.max(0, end - TAIL_CHUNK_BYTES);
      let chunk = Buffer.alloc(end - start);
      await handle.read(chunk, 0, chunk.length, start);
      for (let at = chunk.lastIndexOf(0x0a); at >= 0; at = chunk.lastIndexOf(0x0a)) {
        if (visit(Buffer.concat([chunk.subarray(at + 1), ...pending]))) return done();
        pending = [];
        chunk = chunk.subarray(0, at);
      }
      pending.unshift(chunk);
      end = start;
    }
    visit(Buffer.concat(pending));
    return done();
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

export async function readTranscriptPermissionMode(filePath: string): Promise<string | undefined> {
  const scan = new PermissionModeScan();
  return scanTranscriptTail(filePath, (line) => scan.visit(line), () => scan.mode);
}

export async function readTranscriptModel(filePath: string): Promise<string | undefined> {
  const scan = new ModelScan();
  return scanTranscriptTail(filePath, (line) => scan.visit(line), () => scan.model);
}
