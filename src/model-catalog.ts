import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ClientCapabilities, SessionConfigOption } from "@agentclientprotocol/sdk/unstable";

export const REASONING_EFFORT_LEVELS: NonNullable<ModelInfo["supportedEffortLevels"]> = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export const MODEL_CATALOG: ModelInfo[] = [
  {
    value: "default",
    displayName: "Default (recommended)",
    description: "Opus 5.5 with 1M context · Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: REASONING_EFFORT_LEVELS,
    supportsAutoMode: true,
  },
  {
    value: "fable",
    displayName: "Fable 5.1",
    description:
      "Fable 5.1 with 1M context · Most capable for your hardest and longest-running tasks",
    supportsEffort: true,
    supportedEffortLevels: REASONING_EFFORT_LEVELS,
    supportsAutoMode: true,
  },
  {
    value: "opus",
    displayName: "Opus 5.5",
    description: "Opus 5.5 with 1M context · Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: REASONING_EFFORT_LEVELS,
    supportsAutoMode: true,
  },
  {
    value: "sonnet",
    displayName: "Sonnet 5.5",
    description: "Sonnet 5.5 with 1M context · Most efficient for simpler tasks",
    supportsEffort: true,
    supportedEffortLevels: REASONING_EFFORT_LEVELS,
    supportsAutoMode: true,
  },
  {
    value: "haiku",
    displayName: "Haiku 5.5",
    description: "Haiku 5.5 with 1M context · Fastest for quick answers",
    supportsEffort: true,
    supportedEffortLevels: REASONING_EFFORT_LEVELS,
    supportsAutoMode: true,
  },
];

export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  default: 1_000_000,
  fable: 1_000_000,
  opus: 1_000_000,
  sonnet: 1_000_000,
  haiku: 1_000_000,
};

export const MODEL_ID_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-5-5": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 200_000,
  "claude-fable-5-1": 1_000_000,
  "claude-fable-5": 1_000_000,
  "claude-sonnet-5-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-sonnet-4-6": 200_000,
  "claude-sonnet-4-5-20250929": 200_000,
  "claude-sonnet-4-20250514": 200_000,
  "claude-haiku-5-5": 1_000_000,
  "claude-haiku-4-5": 200_000,
};

export function resolveCatalogValueFromModelId(id: string): string | null {
  if (typeof id !== "string" || id.length === 0) return null;
  if (/claude-opus/.test(id)) return "opus";
  if (/claude-fable/.test(id)) return "fable";
  if (/claude-sonnet/.test(id)) return "sonnet";
  if (/claude-haiku/.test(id)) return "haiku";
  return null;
}

export function modelSelectorDescription(info: ModelInfo): string {
  return info.description ?? "";
}

export const FAST_MODE_MODELS: ReadonlySet<string> = new Set(["default", "opus"]);

export function isFastModeCapableModel(value: string): boolean {
  return FAST_MODE_MODELS.has(value);
}

export const FAST_MODE_CONFIG_ID = "fast";
export const FAST_MODE_ON = "on";
export const FAST_MODE_OFF = "off";

export function clientSupportsBooleanConfigOptions(caps?: ClientCapabilities | null): boolean {
  const booleanCap = caps?.session?.configOptions?.boolean;
  return booleanCap !== null && booleanCap !== undefined;
}

export function resolveFastModeEnabled(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return value === FAST_MODE_ON;
}

export function createFastModeConfigOption(
  enabled: boolean,
  useBooleanOption: boolean,
): SessionConfigOption {
  const base = {
    id: FAST_MODE_CONFIG_ID,
    name: "Fast Mode",
    description:
      "Faster Opus output at a higher usage-credit rate (/fast). Turns off on non-Opus models.",
    category: "model" as const,
  };
  if (useBooleanOption) {
    return { ...base, type: "boolean", currentValue: enabled };
  }
  return {
    ...base,
    type: "select",
    currentValue: enabled ? FAST_MODE_ON : FAST_MODE_OFF,
    options: [
      { value: FAST_MODE_OFF, name: "Off", description: "Standard Opus output speed." },
      {
        value: FAST_MODE_ON,
        name: "On",
        description: "Faster Opus output — draws from usage credits at a higher rate.",
      },
    ],
  };
}

export type FastModeSignal = "available" | "unavailable" | "pending";

function stripControlSequences(raw: string): string {
  /* eslint-disable no-control-regex */
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  /* eslint-enable no-control-regex */
}

const FAST_PANEL_ANCHORS = [
  /fast mode \(research preview\)/i,
  /high-speed mode for opus/i,
  /draws from usage credits at a higher rate/i,
];

const FAST_PENDING_MARKERS = ["checking fast mode availability"];

const FAST_UNAVAILABLE_MARKERS = [
  "requires usage credits",
  "requires a paid subscription",
  "unavailable during evaluation",
  "has been disabled by your organization",
  "only available when using the anthropic api directly",
  "fast mode unavailable",
  "fast mode is not available",
  "fast mode is currently unavailable",
];

export function classifyFastModeSignal(raw: string): FastModeSignal {
  const text = stripControlSequences(raw).toLowerCase();
  if (FAST_PENDING_MARKERS.some((m) => text.includes(m))) return "pending";
  if (FAST_UNAVAILABLE_MARKERS.some((m) => text.includes(m))) return "unavailable";
  if (FAST_PANEL_ANCHORS.some((re) => re.test(text))) return "available";
  return "pending";
}

export const ULTRACODE_CONFIG_ID = "ultracode";

export const ULTRACODE_EFFORT_LEVEL = "xhigh";

export const LEGACY_ULTRACODE_EFFORT_VALUE = "ultracode";

export function ultracodeCommand(on: boolean): string {
  return on ? "/effort ultracode on" : "/effort ultracode off";
}

export function isUltracodeCapableModel(info: ModelInfo | undefined): boolean {
  return info?.supportsEffort === true && (info.supportedEffortLevels ?? []).includes("xhigh");
}

export function resolveUltracodeEnabled(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return value === FAST_MODE_ON;
}

const ULTRACODE_DESCRIPTION = "Run dynamic workflows on every task (/effort ultracode).";

export function createUltracodeConfigOption(
  enabled: boolean,
  useBooleanOption: boolean,
  refusal?: string,
): SessionConfigOption {
  const base = {
    id: ULTRACODE_CONFIG_ID,
    name: "Ultracode",
    description: refusal ? `${ULTRACODE_DESCRIPTION} Off: ${refusal}` : ULTRACODE_DESCRIPTION,
    category: "model_config" as const,
  };
  if (useBooleanOption) {
    return { ...base, type: "boolean", currentValue: enabled };
  }
  return {
    ...base,
    type: "select",
    currentValue: enabled ? FAST_MODE_ON : FAST_MODE_OFF,
    options: [
      { value: FAST_MODE_OFF, name: "Off", description: "No standing orchestration." },
      {
        value: FAST_MODE_ON,
        name: "On",
        description: "Dynamic workflows on every task, at the current effort level.",
      },
    ],
  };
}

export type UltracodeReply =
  { kind: "refused"; reason: string } | { kind: "on" } | { kind: "pending" };

function ptyTextForMatching(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const spaced = raw.replace(/\x1b\[\d*C/g, " ");
  return stripControlSequences(spaced).replace(/\s+/g, " ");
}

export function classifyUltracodeReply(raw: string): UltracodeReply {
  const text = ptyTextForMatching(raw);
  const last = (re: RegExp): { at: number; match: RegExpMatchArray } | undefined => {
    let found: { at: number; match: RegExpMatchArray } | undefined;
    for (const match of text.matchAll(re)) found = { at: match.index ?? 0, match };
    return found;
  };
  const candidates: Array<{ at: number; reply: UltracodeReply }> = [];
  const workflows = last(/ultracode needs dynamic workflows enabled/gi);
  if (workflows) {
    candidates.push({
      at: workflows.at,
      reply: {
        kind: "refused",
        reason: "Ultracode needs dynamic workflows enabled (see /config).",
      },
    });
  }
  const model = last(/ultracode isn['\u2019]?t available on (\S+)/gi);
  if (model) {
    const name = model.match[1].replace(/\.$/, "");
    candidates.push({
      at: model.at,
      reply: { kind: "refused", reason: `Ultracode isn't available on ${name}.` },
    });
  }
  const on = last(/ultracode on \(this session only\)/gi);
  if (on) candidates.push({ at: on.at, reply: { kind: "on" } });
  if (candidates.length === 0) return { kind: "pending" };
  candidates.sort((a, b) => b.at - a.at);
  return candidates[0].reply;
}

export const DEFAULT_MODEL_INFO: ModelInfo = MODEL_CATALOG[0];
