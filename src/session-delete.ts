import { deleteSession as sdkDeleteSession } from "@anthropic-ai/claude-agent-sdk";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

export function isSdkSessionNotFound(error: unknown): boolean {
  return error instanceof Error && /^Session \S+ not found in /.test(error.message);
}

export async function deleteSessionIfStored(
  sessionId: string,
  deleteSession: (sessionId: string) => Promise<void> = sdkDeleteSession,
): Promise<void> {
  if (!isSessionId(sessionId)) return;
  try {
    await deleteSession(sessionId);
  } catch (error) {
    if (isSdkSessionNotFound(error)) return;
    throw error;
  }
}
