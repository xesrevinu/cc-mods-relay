export const SUBSCRIPTION_ENTRYPOINTS = [
  "cli",
  "claude-vscode",
  "vscode",
  "jetbrains",
  "firstParty",
  "local-agent",
] as const;

export const CREDIT_ENTRYPOINTS = ["sdk-ts", "sdk-py", "sdk-cli", "print"] as const;

export type EntrypointClass = "subscription" | "credit" | "unknown";

export function classifyEntrypoint(entrypoint: string): EntrypointClass {
  if ((SUBSCRIPTION_ENTRYPOINTS as readonly string[]).includes(entrypoint)) {
    return "subscription";
  }
  if ((CREDIT_ENTRYPOINTS as readonly string[]).includes(entrypoint)) {
    return "credit";
  }
  return "unknown";
}

export interface WatchedMessage {
  type?: string;
  entrypoint?: string;
  sessionId?: string;
  [k: string]: unknown;
}

export type GuardDecision =
  | { action: "skip" }
  | { action: "allow"; entrypoint: string; entrypointClass: "subscription" }
  | { action: "abort"; entrypoint: string; entrypointClass: "credit" | "unknown" };

export function inspectEvent(event: WatchedMessage): GuardDecision {
  if (event.type !== "assistant" && event.type !== "user") {
    return { action: "skip" };
  }
  const entrypoint = event.entrypoint ?? "";
  const entrypointClass = classifyEntrypoint(entrypoint);
  if (entrypointClass === "subscription") {
    return { action: "allow", entrypoint, entrypointClass };
  }
  return { action: "abort", entrypoint, entrypointClass };
}

export interface GuardHooks {
  alert(message: string): void;
  stopSession(info: {
    entrypoint: string;
    sessionId?: string;
    entrypointClass: "credit" | "unknown";
  }): void;
}

export function guardEvent(event: WatchedMessage, hooks: GuardHooks): GuardDecision {
  const decision = inspectEvent(event);
  if (decision.action !== "abort") {
    return decision;
  }
  const message =
    `[billing §10] BLOCKED ${decision.entrypointClass}-class entrypoint "${decision.entrypoint}" ` +
    `on session "${event.sessionId ?? "(unknown)"}": this client bills on API credit, not the ` +
    `Claude subscription. Stopping the session to avoid silent credit billing — the entrypoint is ` +
    `NOT being rewritten (forcing it to 'cli' would be evasion).`;
  hooks.alert(message);
  hooks.stopSession({
    entrypoint: decision.entrypoint,
    sessionId: event.sessionId,
    entrypointClass: decision.entrypointClass,
  });
  return decision;
}

export function assertCleanBillingEnv(env: Record<string, string | undefined>): void {
  const leaked = Object.keys(env).filter(
    (key) =>
      env[key] !== undefined &&
      (key === "CLAUDE_CODE_ENTRYPOINT" || key.startsWith("CLAUDE_AGENT_SDK_")),
  );
  if (leaked.length === 0) {
    return;
  }
  throw new Error(
    `[billing §10] REFUSING TO SPAWN: ${leaked.length} billing-sensitive env key(s) leaked into the ` +
      `spawn env: ${leaked.join(", ")}. These would silently bill the spawned TUI as API credit ` +
      `(R1) instead of the Claude subscription. The spawn-env sanitize must strip them BEFORE spawn — ` +
      `aborting rather than launch a credit-billed run.`,
  );
}
