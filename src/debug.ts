import { appendFileSync } from "node:fs";

/** First-run / live e2e tracing. Off unless CC_MODS_DEBUG=1. */
export function debugOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CC_MODS_DEBUG === "1" || env.CC_MODS_DEBUG === "true";
}

export function debug(message: string, extra?: unknown): void {
  if (!debugOn()) return;
  const line = extra === undefined ? `[cc-mods] ${message}` : `[cc-mods] ${message} ${summarize(extra)}`;
  console.error(line);
  const file = process.env.CC_MODS_DEBUG_FILE;
  if (!file) return;
  try {
    appendFileSync(file, `${line}\n`);
  } catch {
    /* diagnostic file is best-effort */
  }
}

export function summarize(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === "string" && item.length > 240) return `${item.slice(0, 120)}…[${item.length} chars]`;
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const row = item as Record<string, unknown>;
        if (typeof row.base64 === "string") {
          return { ...row, base64: `<${row.base64.length} chars>` };
        }
      }
      return item;
    });
  } catch {
    return String(value);
  }
}
