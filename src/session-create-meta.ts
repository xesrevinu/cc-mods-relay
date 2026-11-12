import type { ModelInfo, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { isSafeAgentRef } from "./agent-catalog.js";
import type { CcModsRelayFlags } from "./engine-pty.js";
import { MODEL_CATALOG, resolveCatalogValueFromModelId } from "./model-catalog.js";
import { ASK_USER_QUESTION_TOOL } from "./permissions/deny.js";
import { isSessionId } from "./session-delete.js";

const GROK_BUILD_PROFILE = /^grok-build(?:-|$)/i;

export type SessionCreateSeed = {
  permissionMode?: PermissionMode;
  model?: string;
  preferredSessionId?: string;
  denyAskUserQuestion: boolean;
  agent?: string;
};

function asRecord(meta: unknown): Record<string, unknown> | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  return meta as Record<string, unknown>;
}

/** Grok always stamps `_meta.yoloMode` / `_meta.autoMode` on session/new. Yolo wins. */
export function permissionModeFromClientMeta(
  meta: unknown,
  allowBypass: boolean = true,
): PermissionMode | undefined {
  const rec = asRecord(meta);
  if (!rec) return undefined;
  if (rec.yoloMode === true) return allowBypass ? "bypassPermissions" : "default";
  if (rec.autoMode === true) return "auto";
  if (rec.yoloMode === false || rec.autoMode === false) return "default";
  return undefined;
}

export function modelFromClientMeta(
  meta: unknown,
  catalog: ModelInfo[] = MODEL_CATALOG,
): string | undefined {
  const rec = asRecord(meta);
  if (typeof rec?.modelId !== "string") return undefined;
  const id = rec.modelId.trim();
  if (!id) return undefined;
  if (catalog.some((m) => m.value === id)) return id === "default" ? undefined : id;
  const mapped = resolveCatalogValueFromModelId(id);
  if (mapped && catalog.some((m) => m.value === mapped)) return mapped;
  return undefined;
}

export function preferredSessionIdFromClientMeta(meta: unknown): string | undefined {
  const rec = asRecord(meta);
  return isSessionId(rec?.sessionId) ? rec.sessionId : undefined;
}

export function denyAskUserQuestionFromClientMeta(meta: unknown): boolean {
  return asRecord(meta)?.askUserQuestion === false;
}

export function agentFromClientMeta(
  meta: unknown,
  agents: { value: string }[] = [],
): string | undefined {
  const rec = asRecord(meta);
  const raw = rec?.agentProfile;
  if (typeof raw !== "string") return undefined;
  const name = raw.trim();
  if (!name || GROK_BUILD_PROFILE.test(name) || !isSafeAgentRef(name)) return undefined;
  if (!agents.some((a) => a.value === name)) return undefined;
  return name;
}

export function parseSessionCreateMeta(
  meta: unknown,
  opts: {
    allowBypass?: boolean;
    catalog?: ModelInfo[];
    agents?: { value: string }[];
  } = {},
): SessionCreateSeed {
  return {
    permissionMode: permissionModeFromClientMeta(meta, opts.allowBypass ?? true),
    model: modelFromClientMeta(meta, opts.catalog),
    preferredSessionId: preferredSessionIdFromClientMeta(meta),
    denyAskUserQuestion: denyAskUserQuestionFromClientMeta(meta),
    agent: agentFromClientMeta(meta, opts.agents),
  };
}

export function withDeniedAskUserQuestion(
  disallowed: string[] | undefined,
  deny: boolean,
): string[] | undefined {
  if (!deny) return disallowed;
  if (disallowed?.includes(ASK_USER_QUESTION_TOOL)) return disallowed;
  return [...(disallowed ?? []), ASK_USER_QUESTION_TOOL];
}

export function extraFlagsWithModel(
  base: CcModsRelayFlags,
  model: string | undefined,
): CcModsRelayFlags {
  if (!model || model === "default") return base;
  return { ...base, model };
}
