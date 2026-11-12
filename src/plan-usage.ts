/**
 * Claude.ai plan rate-limit windows behind `/usage`.
 *
 * An ephemeral SDK `query({ persistSession: false })` plus
 * `usage_EXPERIMENTAL_…({ skipBehaviors: false })` returns the same
 * five-hour / weekly / Fable meters as the TUI `/usage` dialog, without
 * writing JSONL. Session cost/tokens still come from the live ACP session.
 */
import type { Query, SDKControlGetUsageResponse, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudePath } from "./claude-path.js";
import {
  assertLiveCatalogAllowed,
  catalogQueryOptions,
  silentPrompt,
} from "./live-model-catalog.js";

export const PLAN_USAGE_TTL_MS = 60_000;
export const PLAN_USAGE_TIMEOUT_MS = 20_000;

export type PlanWindow = {
  label: string;
  utilization: number;
  resetsAt?: string | null;
};

export type PlanContributor = {
  pct: number;
  title: string;
  detail?: string;
};

export type PlanMcpShare = {
  name: string;
  pct: number;
};

export type PlanUsageView = {
  windows: PlanWindow[];
  contributors?: PlanContributor[];
  mcpServers?: PlanMcpShare[];
};

export type PlanUsageSource = () => Promise<PlanUsageView | undefined>;

type PlanQuery = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: ReturnType<typeof catalogQueryOptions>;
}) => Pick<Query, "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET" | "close">;

interface CacheEntry {
  view: PlanUsageView;
  at: number;
}

let cache: CacheEntry | null = null;

export function resetPlanUsageCache(): void {
  cache = null;
}

function finitePercent(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function windowFrom(
  label: string,
  utilization: number | null | undefined,
  resetsAt: string | null | undefined,
): PlanWindow | undefined {
  const pct = finitePercent(utilization);
  if (pct === undefined) return undefined;
  return { label, utilization: pct, resetsAt };
}

type ExtraLimitRow = {
  kind?: string;
  percent?: number | null;
  resets_at?: string | null;
  scope?: { model?: { display_name?: string | null } | null } | null;
};

function extraLimitRows(limits: NonNullable<SDKControlGetUsageResponse["rate_limits"]>): PlanWindow[] {
  const rows = (limits as { limits?: ExtraLimitRow[] }).limits ?? [];
  const windows: PlanWindow[] = [];
  for (const row of rows) {
    const pct = finitePercent(row.percent);
    if (pct === undefined) continue;
    const label =
      row.kind === "session"
        ? "Current session"
        : row.kind === "weekly_all"
          ? "Current week (all models)"
          : row.kind === "weekly_scoped"
            ? `Current week (${row.scope?.model?.display_name ?? "model"})`
            : undefined;
    if (!label) continue;
    windows.push({ label, utilization: pct, resetsAt: row.resets_at });
  }
  return windows;
}

export function planUsageFromSdk(report: SDKControlGetUsageResponse): PlanUsageView | undefined {
  if (!report.rate_limits_available || !report.rate_limits) return undefined;
  const limits = report.rate_limits;
  const windows: PlanWindow[] = [];

  const fiveHour = windowFrom("Current session", limits.five_hour?.utilization, limits.five_hour?.resets_at);
  const week = windowFrom(
    "Current week (all models)",
    limits.seven_day?.utilization,
    limits.seven_day?.resets_at,
  );
  if (fiveHour) windows.push(fiveHour);
  if (week) windows.push(week);
  for (const scoped of limits.model_scoped ?? []) {
    const name = scoped.display_name.trim();
    const row = windowFrom(
      name ? `Current week (${name})` : "Current week (model)",
      scoped.utilization,
      scoped.resets_at,
    );
    if (row) windows.push(row);
  }

  if (windows.length === 0) {
    for (const row of extraLimitRows(limits)) windows.push(row);
  }

  if (windows.length === 0) return undefined;

  const day = report.behaviors?.day;
  const contributors = day?.recommendations
    ?.filter((item) => finitePercent(item.pct) !== undefined && item.title.trim().length > 0)
    .map((item) => ({
      pct: item.pct,
      title: item.title,
      ...(item.detail ? { detail: item.detail } : {}),
    }));
  const mcpServers = day?.mcp_servers
    ?.filter((item) => finitePercent(item.pct) !== undefined && item.name.trim().length > 0)
    .map((item) => ({ name: item.name, pct: item.pct }));

  return {
    windows,
    ...(contributors && contributors.length > 0 ? { contributors } : {}),
    ...(mcpServers && mcpServers.length > 0 ? { mcpServers } : {}),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
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

async function livePlanUsage(queryFn: PlanQuery, pathToClaude: string): Promise<PlanUsageView | undefined> {
  const stop = new AbortController();
  const q = queryFn({
    prompt: silentPrompt(stop.signal),
    options: catalogQueryOptions(pathToClaude),
  });
  try {
    const report = await withTimeout(
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: false }),
      PLAN_USAGE_TIMEOUT_MS,
      "plan usage",
    );
    return planUsageFromSdk(report);
  } finally {
    try {
      q.close();
    } catch {
      /* ignore */
    }
    stop.abort();
  }
}

export async function fetchPlanUsage(opts: { queryFn?: PlanQuery; now?: () => number } = {}): Promise<PlanUsageView | undefined> {
  assertLiveCatalogAllowed();
  const now = opts.now ?? Date.now;
  if (cache && now() - cache.at < PLAN_USAGE_TTL_MS) return cache.view;
  const { query } = opts.queryFn
    ? { query: opts.queryFn }
    : await import("@anthropic-ai/claude-agent-sdk");
  const view = await livePlanUsage(query, resolveClaudePath());
  if (view) cache = { view, at: now() };
  return view;
}

export function formatResetAt(
  iso: string | null | undefined,
  opts: { now?: Date; timeZone?: string } = {},
): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  const timeZone = opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = opts.now ?? new Date();
  const clock = formatClock(date, timeZone);
  const zone = ` (${timeZone})`;
  if (ymd(date, timeZone) === ymd(now, timeZone)) return `Resets ${clock}${zone}`;
  return `Resets ${formatMonthDay(date, timeZone)} at ${clock}${zone}`;
}

function ymd(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatMonthDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
  }).format(date);
}

function formatClock(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "";
  const period = (parts.find((part) => part.type === "dayPeriod")?.value ?? "").toLowerCase().replaceAll(".", "");
  if (minute === "00") return `${hour}${period}`;
  return `${hour}:${minute}${period}`;
}
