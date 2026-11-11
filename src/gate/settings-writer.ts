import * as fs from "node:fs/promises";
import * as path from "node:path";

function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (c === "\n") {
        inLineComment = false;
        out += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\" && next) {
        out += next;
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    out += c;
  }
  out = out.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(out);
}

export const FORK_HOOK_MARKER_PATH = "/__fork-acp-gate__";

export const FORK_HOOK_MARKER_KEY = "__forkAcpGate";

export const DEFAULT_HOOK_TIMEOUT_SECONDS = 600;

export const FORK_HOOK_MATCHER = "*";

export interface HttpHookEntry {
  type: "http";
  url: string;
  timeout: number;
}

export interface PreToolUseGroup {
  matcher: string;
  hooks: HttpHookEntry[];
  [FORK_HOOK_MARKER_KEY]?: true;
}

export interface BuildHookOptions {
  token?: string;
  timeout?: number;
}

export function buildHookEntry(
  port: number,
  optsOrTimeout: number | BuildHookOptions = DEFAULT_HOOK_TIMEOUT_SECONDS,
): PreToolUseGroup {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(
      `buildHookEntry: port must be a positive integer in 1..65535, got ${String(port)} — refusing ` +
        `to build a malformed hook (claude would ignore it and the tool would run ungated).`,
    );
  }
  const opts: BuildHookOptions =
    typeof optsOrTimeout === "number" ? { timeout: optsOrTimeout } : optsOrTimeout;
  const timeout = opts.timeout ?? DEFAULT_HOOK_TIMEOUT_SECONDS;
  const tokenSuffix = opts.token ? `/${opts.token}` : "";
  return {
    matcher: FORK_HOOK_MATCHER,
    hooks: [
      {
        type: "http",
        url: `http://127.0.0.1:${port}${FORK_HOOK_MARKER_PATH}${tokenSuffix}`,
        timeout,
      },
    ],
    [FORK_HOOK_MARKER_KEY]: true,
  };
}

export function isForkHookGroup(group: unknown): boolean {
  if (typeof group !== "object" || group === null) {
    return false;
  }
  const g = group as Record<string, unknown>;
  if (g[FORK_HOOK_MARKER_KEY] === true) {
    return true;
  }
  const hooks = g.hooks;
  if (Array.isArray(hooks)) {
    for (const h of hooks) {
      if (
        h !== null &&
        typeof h === "object" &&
        typeof (h as { url?: unknown }).url === "string" &&
        (h as { url: string }).url.includes(FORK_HOOK_MARKER_PATH)
      ) {
        return true;
      }
    }
  }
  return false;
}

export interface SettingsLike {
  hooks?: {
    PreToolUse?: unknown[];
    [event: string]: unknown;
  };
  [key: string]: unknown;
}

export function mergeHook(prior: SettingsLike | null, group: PreToolUseGroup): SettingsLike {
  if (prior === null || prior === undefined) {
    return { hooks: { PreToolUse: [structuredClone(group)] } };
  }
  if (typeof prior !== "object" || Array.isArray(prior)) {
    throw new Error(
      `mergeHook: prior settings root must be a JSON object, got ${Array.isArray(prior) ? "array" : typeof prior}. ` +
        `Refusing to overwrite a malformed settings.local.json (the user's config is never clobbered blindly).`,
    );
  }
  const merged = structuredClone(prior) as SettingsLike;
  if (typeof merged.hooks !== "object" || merged.hooks === null || Array.isArray(merged.hooks)) {
    merged.hooks = {};
  }
  const hooks = merged.hooks as { PreToolUse?: unknown[]; [k: string]: unknown };
  if (!Array.isArray(hooks.PreToolUse)) {
    hooks.PreToolUse = [];
  }
  hooks.PreToolUse = hooks.PreToolUse.filter((g) => !isForkHookGroup(g));
  hooks.PreToolUse.push(structuredClone(group));
  return merged;
}

export function parsePriorSettings(text: string): SettingsLike {
  try {
    const parsed = parseJsonc(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        `parsed root is ${Array.isArray(parsed) ? "an array" : typeof parsed}, expected an object`,
      );
    }
    return parsed as SettingsLike;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `parsePriorSettings: settings.local.json is not parseable JSON/JSONC (${reason}). Refusing to ` +
        `clobber it blindly — the inject path must fall back to a safe handling of a corrupt file.`,
      { cause: err },
    );
  }
}

export interface Backup {
  settingsPath: string;
  existed: boolean;
  priorBytes: Buffer | null;
}

export interface RestoreResult {
  path: "surgical" | "backup";
}

async function durableWrite(filePath: string, text: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.fork-tmp-${process.pid}-${Date.now()}`);
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(tmp, "w");
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tmp, filePath);
    try {
      const dirHandle = await fs.open(dir, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
    }
  } catch (err) {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
      }
    }
    try {
      await fs.rm(tmp, { force: true });
    } catch {
    }
    throw err;
  }
}

async function readPriorBytes(settingsPath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(settingsPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function injectHook(opts: {
  settingsPath: string;
  port: number;
  timeout?: number;
  token?: string;
}): Promise<Backup> {
  const { settingsPath, port, timeout, token } = opts;

  const priorBytes = await readPriorBytes(settingsPath);
  const backup: Backup = { settingsPath, existed: priorBytes !== null, priorBytes };

  const group = buildHookEntry(port, { token, timeout });
  let prior: SettingsLike | null = null;
  if (priorBytes !== null) {
    const text = priorBytes.toString("utf8").trim();
    prior = text.length === 0 ? null : parsePriorSettings(text);
  }
  const merged = mergeHook(prior, group);
  const out = `${JSON.stringify(merged, null, 2)}\n`;

  try {
    await durableWrite(settingsPath, out);
  } catch (err) {
    try {
      if (backup.existed && backup.priorBytes !== null) {
        await durableWrite(settingsPath, backup.priorBytes.toString("utf8"));
      } else {
        await fs.rm(settingsPath, { force: true });
      }
    } catch {
    }
    throw new Error(
      `injectHook: failed to write ${settingsPath} (${err instanceof Error ? err.message : String(err)}). ` +
        `Rolled back to the prior on-disk state; refusing to leave a half-written settings.local.json.`,
      { cause: err },
    );
  }

  return backup;
}

async function applyBackup(backup: Backup): Promise<void> {
  if (backup.existed && backup.priorBytes !== null) {
    await durableWrite(backup.settingsPath, backup.priorBytes.toString("utf8"));
  } else {
    await fs.rm(backup.settingsPath, { force: true });
  }
}

export async function restore(backup: Backup): Promise<RestoreResult> {
  let currentBytes: Buffer | null;
  try {
    currentBytes = await readPriorBytes(backup.settingsPath);
  } catch {
    currentBytes = null;
  }

  if (currentBytes === null) {
    try {
      await applyBackup(backup);
      return { path: "backup" };
    } catch (err) {
      throw new Error(
        `restore: file missing and backup re-apply failed (${err instanceof Error ? err.message : String(err)}).`,
        { cause: err },
      );
    }
  }

  try {
    const text = currentBytes.toString("utf8").trim();
    const parsed = text.length === 0 ? {} : parsePriorSettings(text);
    const next = structuredClone(parsed) as SettingsLike;
    const hooks = next.hooks as { PreToolUse?: unknown[]; [k: string]: unknown } | undefined;

    let removedSomething = false;
    if (hooks && Array.isArray(hooks.PreToolUse)) {
      const before = hooks.PreToolUse.length;
      hooks.PreToolUse = hooks.PreToolUse.filter((g) => !isForkHookGroup(g));
      removedSomething = hooks.PreToolUse.length < before;
      if (hooks.PreToolUse.length === 0) {
        delete hooks.PreToolUse;
      }
      if (Object.keys(hooks).length === 0) {
        delete next.hooks;
      }
    }

    if (!backup.existed && Object.keys(next).length === 0) {
      await fs.rm(backup.settingsPath, { force: true });
      return { path: "surgical" };
    }

    void removedSomething;
    await durableWrite(backup.settingsPath, `${JSON.stringify(next, null, 2)}\n`);
    return { path: "surgical" };
  } catch {
    try {
      await applyBackup(backup);
      return { path: "backup" };
    } catch (err) {
      throw new Error(
        `restore: surgical removal failed AND backup fallback failed ` +
          `(${err instanceof Error ? err.message : String(err)}). The fork hook may be stranded — manual ` +
          `inspection of ${backup.settingsPath} is required.`,
        { cause: err },
      );
    }
  }
}

const ULTRACODE_SETTINGS_KEY = "ultracode";

export async function applyUltracodeSettings(settingsPath: string, active: boolean): Promise<void> {
  const priorBytes = await readPriorBytes(settingsPath);
  let current: SettingsLike = {};
  if (priorBytes !== null) {
    const text = priorBytes.toString("utf8").trim();
    if (text.length > 0) {
      current = parsePriorSettings(text);
    }
  }

  const next = structuredClone(current) as SettingsLike;
  if (active) {
    next[ULTRACODE_SETTINGS_KEY] = true;
  } else {
    delete next[ULTRACODE_SETTINGS_KEY];
  }

  await durableWrite(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
}
