import type { ModelInfo, Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { MODEL_CATALOG } from "./model-catalog.js";
import { filterSupersededModels } from "./model-recency.js";
import { resolveClaudePath } from "./claude-path.js";

export const CATALOG_TTL_MS = 10 * 60 * 1000;

export const CATALOG_TIMEOUT_MS = 20_000;

export type SupportedModelsSource = () => Promise<ModelInfo[]>;

interface CatalogLogger {
  log: (...args: unknown[]) => void;
}

interface CacheEntry {
  models: ModelInfo[];
  at: number;
  source: SupportedModelsSource;
}
let cache: CacheEntry | null = null;
let fallbackReported = false;

export function resetLiveModelCatalogCache(): void {
  cache = null;
  fallbackReported = false;
}

export const MODEL_CATALOG_ENV = "CLAUDE_TUI_MODEL_CATALOG";

export const LIVE_CATALOG_TESTS_ENV = "CLAUDE_TUI_LIVE_CATALOG_TESTS";

export class LiveCatalogInTestsError extends Error {
  constructor() {
    super(
      "the live model catalogue (a real `claude` spawn) was requested under the node test runner. " +
        "Run tests through `npm run test:fork` (it preloads test/helpers/test-setup.ts, which installs " +
        "the stub), inject `deps.modelCatalogSource`, or opt in with " +
        `${LIVE_CATALOG_TESTS_ENV}=1 for a test that truly needs the CLI.`,
    );
    this.name = "LiveCatalogInTestsError";
  }
}

export function assertLiveCatalogAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_TEST_CONTEXT && env[LIVE_CATALOG_TESTS_ENV] !== "1") {
    throw new LiveCatalogInTestsError();
  }
}

let defaultOverride: SupportedModelsSource | undefined;

export function setDefaultModelCatalogSource(source: SupportedModelsSource | undefined): void {
  defaultOverride = source;
  cache = null;
}

function defaultSource(): Promise<ModelInfo[]> {
  return defaultOverride ? defaultOverride() : liveSource();
}

export function silentPrompt(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  const ended = new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
    const end = () => resolve({ value: undefined, done: true });
    if (signal.aborted) end();
    else signal.addEventListener("abort", end, { once: true });
  });
  return { [Symbol.asyncIterator]: () => ({ next: () => ended }) };
}

export function catalogQueryOptions(pathToClaudeCodeExecutable: string): Options {
  return {
    pathToClaudeCodeExecutable,
    settingSources: ["user"],
    settings: { disableAllHooks: true },
    strictMcpConfig: true,
    mcpServers: {},
    persistSession: false,
  };
}

export type CatalogQueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => Pick<Query, "supportedModels" | "close">;

export async function readSupportedModels(
  queryFn: CatalogQueryFn,
  pathToClaudeCodeExecutable: string,
): Promise<ModelInfo[]> {
  const stop = new AbortController();
  const q = queryFn({
    prompt: silentPrompt(stop.signal),
    options: catalogQueryOptions(pathToClaudeCodeExecutable),
  });
  try {
    return await q.supportedModels();
  } finally {
    try {
      q.close();
    } catch {
    }
    stop.abort();
  }
}

async function liveSource(): Promise<ModelInfo[]> {
  assertLiveCatalogAllowed();
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  return readSupportedModels(query, resolveClaudePath());
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`model catalogue fetch timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function nameDefaultRow(models: ModelInfo[]): ModelInfo[] {
  const defaultRow = models.find((m) => m.value === "default");
  const resolved = defaultRow?.resolvedModel;
  if (!defaultRow || !resolved) return models;
  const sibling = models.find((m) => m.value !== "default" && m.resolvedModel === resolved);
  const description = sibling?.displayName ?? resolved;
  return models.map((m) => (m === defaultRow ? { ...m, description } : m));
}

export async function resolveModelCatalog(
  logger?: CatalogLogger,
  source: SupportedModelsSource = defaultSource,
): Promise<ModelInfo[]> {
  if (source === defaultSource && !defaultOverride && process.env[MODEL_CATALOG_ENV] === "builtin")
    return MODEL_CATALOG;
  if (cache && cache.source === source && Date.now() - cache.at < CATALOG_TTL_MS)
    return cache.models;
  try {
    const raw = await withTimeout(source(), CATALOG_TIMEOUT_MS);
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error("the CLI returned no models");
    }
    const models = nameDefaultRow(filterSupersededModels(raw));
    const resolved = models.length > 0 ? models : raw;
    cache = { models: resolved, at: Date.now(), source };
    return resolved;
  } catch (error) {
    if (error instanceof LiveCatalogInTestsError) throw error;
    if (!fallbackReported) {
      fallbackReported = true;
      logger?.log(
        `Could not read the model catalogue from the CLI; using the built-in list for this process. ${String(error)}`,
      );
    }
    return MODEL_CATALOG;
  }
}
