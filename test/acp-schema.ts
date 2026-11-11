import { zSessionNotification } from "../node_modules/@agentclientprotocol/sdk/dist/v1/unstable/schema/zod.gen.js";
import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";
import { WORKSPACE_TOOLS } from "../src/tools/forward.js";
import { toolInfoFromToolUse } from "../src/tools.js";

export const ACP_KIND: Record<(typeof WORKSPACE_TOOLS)[number], string> = {
  Read: "read",
  Write: "edit",
  Edit: "edit",
  Glob: "search",
  Grep: "search",
  NotebookEdit: "edit",
  Bash: "execute",
  PowerShell: "execute",
};

export function assertAcpNotification(note: SessionNotification): void {
  zSessionNotification.parse(note);
}

export function expectedKind(tool: string): string {
  return (ACP_KIND as Record<string, string>)[tool] ?? toolInfoFromToolUse({ id: "x", name: tool, input: {} }).kind;
}
