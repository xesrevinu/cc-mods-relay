/** Locale keys copied from the TUI host onto local Bash/Monitor. */
export const TUI_LOCALE_KEYS = [
  "TZ",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_TIME",
  "LC_MESSAGES",
  "LC_COLLATE",
  "LC_NUMERIC",
  "LC_MONETARY",
] as const;

/** TUI PTY face. Mini always sets these in engine-pty; overlay so `echo $TERM` matches. */
export const TUI_DISPLAY_KEYS = ["TERM", "COLORTERM", "FORCE_COLOR"] as const;

export const TUI_FACE_KEYS = [...TUI_LOCALE_KEYS, ...TUI_DISPLAY_KEYS] as const;

export type TuiLocale = Partial<Record<(typeof TUI_FACE_KEYS)[number], string>>;

const FACE_KEY = new Set<string>(TUI_FACE_KEYS);

const DENY_PREFIXES = [
  "AWS_",
  "AZURE_",
  "GOOGLE_",
  "GCP_",
  "OPENAI_",
  "ANTHROPIC_",
  "CURSOR_",
  "VSCODE_",
  "ELECTRON_",
  "FORK_",
  "CLAUDE_TUI_",
  "CC_MODS_",
  "SSH_",
  "GITHUB_",
  "GITLAB_",
  "GH_",
  "NPM_",
  "NODE_AUTH_",
] as const;

const DENY_KEYS = new Set([
  "SECURITYSESSIONID",
  "LaunchInstanceID",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "COLORFGBG",
  "ITERM_SESSION_ID",
  "ITERM_PROFILE",
  "__CF_USER_TEXT_ENCODING",
  "XPC_SERVICE_NAME",
  "XPC_FLAGS",
  "COMMAND_MODE",
]);

const DENY_SUFFIX = /(_TOKEN|_SECRET|_PASSWORD|_API_KEY|_ACCESS_KEY|_PRIVATE_KEY)$/i;
const TZ_NAME = /^[A-Za-z][A-Za-z0-9+_/-]{0,63}$/;
const LOCALE_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.,@-]{0,63}$/;
const TERM_VALUE = /^[A-Za-z0-9._+-]{1,32}$/;
const COLORTERM_VALUE = /^[A-Za-z0-9._+-]{1,32}$/;
const FORCE_COLOR_VALUE = /^(?:[0-3]|true|false)$/i;

export function denyWorkspaceEnvKey(key: string): boolean {
  if (DENY_KEYS.has(key)) return true;
  if (DENY_PREFIXES.some((prefix) => key.startsWith(prefix))) return true;
  if (DENY_SUFFIX.test(key)) return true;
  return false;
}

function validFaceValue(key: string, value: string): boolean {
  if (key === "TZ") return TZ_NAME.test(value);
  if (key === "TERM") return TERM_VALUE.test(value);
  if (key === "COLORTERM") return COLORTERM_VALUE.test(value);
  if (key === "FORCE_COLOR") return FORCE_COLOR_VALUE.test(value);
  return LOCALE_VALUE.test(value);
}

/** Keep Mini TZ/LANG/LC_* and TERM only. Ignore anything else a helper might attach. */
export function parseTuiEnv(raw: unknown): TuiLocale {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: TuiLocale = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!FACE_KEY.has(key) || typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || !validFaceValue(key, trimmed)) continue;
    out[key as keyof TuiLocale] = trimmed;
  }
  return out;
}

export function stripClientEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || denyWorkspaceEnvKey(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Wipe client locale/display keys first, then apply Mini's snapshot.
 * A missing Mini TZ must not leave this laptop's TZ (or LC_ALL) in place —
 * `date` would still follow /etc/localtime here.
 */
export function applyTuiLocale(base: NodeJS.ProcessEnv, locale: TuiLocale): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const key of TUI_FACE_KEYS) delete out[key];
  for (const key of TUI_FACE_KEYS) {
    const value = locale[key];
    if (value) out[key] = value;
  }
  return out;
}

/**
 * Client spawn env for workspace shells: drop laptop secrets and editor identity,
 * then overlay the TUI host timezone/locale/TERM so `date` / `locale` / `echo $TERM`
 * match Mini. PATH and HOME stay this machine's — tools have to run here.
 */
export function workspaceSpawnEnv(base: NodeJS.ProcessEnv, tuiEnv?: unknown): NodeJS.ProcessEnv {
  return applyTuiLocale(stripClientEnv(base), parseTuiEnv(tuiEnv));
}

/** Re-apply Mini face after direnv, which may have written TZ/LANG from a client `.envrc`. */
export function pinTuiLocale(base: NodeJS.ProcessEnv, tuiEnv?: unknown): NodeJS.ProcessEnv {
  return applyTuiLocale(base, parseTuiEnv(tuiEnv));
}
