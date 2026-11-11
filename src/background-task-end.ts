export type BackgroundTaskEnd = { status: string; exitCode: number };

const BLOCK = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const SUMMARY_CODE = /exit code (\d+)/i;

function tag(block: string, name: string): string | undefined {
  const open = `<${name}>`;
  const start = block.indexOf(open);
  if (start === -1) return undefined;
  const end = block.indexOf(`</${name}>`, start + open.length);
  if (end === -1) return undefined;
  return block.slice(start + open.length, end).trim();
}

function endOf(status: string, summary: string | undefined): BackgroundTaskEnd {
  const named = summary?.match(SUMMARY_CODE);
  if (named) return { status, exitCode: Number(named[1]) };
  return { status, exitCode: status === "completed" ? 0 : 1 };
}

function notificationTexts(record: Record<string, unknown>): string[] {
  const texts: string[] = [];
  if (record.type === "queue-operation" && typeof record.content === "string") {
    texts.push(record.content);
  }
  const attachment = record.attachment as { type?: unknown; prompt?: unknown } | undefined;
  if (record.type === "attachment" && attachment?.type === "queued_command") {
    if (typeof attachment.prompt === "string") texts.push(attachment.prompt);
  }
  const message = record.message as { role?: unknown; content?: unknown } | undefined;
  if (record.type === "user" && message?.role === "user") {
    if (typeof message.content === "string") texts.push(message.content);
    else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        const b = block as { type?: unknown; text?: unknown };
        if (b?.type === "text" && typeof b.text === "string") texts.push(b.text);
      }
    }
  }
  return texts;
}

export function backgroundTaskEnds(lines: readonly string[]): Map<string, BackgroundTaskEnd> {
  const ends = new Map<string, BackgroundTaskEnd>();
  for (const line of lines) {
    if (!line.includes("task-notification")) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") continue;
    for (const text of notificationTexts(record as Record<string, unknown>)) {
      for (const match of text.matchAll(BLOCK)) {
        const block = match[1];
        const toolUseId = tag(block, "tool-use-id");
        const status = tag(block, "status");
        if (!toolUseId || !status) continue;
        ends.set(toolUseId, endOf(status, tag(block, "summary")));
      }
    }
  }
  return ends;
}
