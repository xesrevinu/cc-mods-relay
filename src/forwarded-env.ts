export const FORWARDED_ENV = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "CC_MODS_DEBUG",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_TUI_BACKEND",
  "CLAUDE_TUI_HERDR_SESSION",
  "CLAUDE_TUI_HERDR_BIN",
  "CLAUDE_TUI_HERDR_HOME",
  "CC_MODS_MOCK",
  "FORK_GATE",
  "DISABLE_TELEMETRY",
  "DISABLE_ERROR_REPORTING",
  "DISABLE_AUTOUPDATER",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "CLAUDE_CODE_DISABLE_CLAUDE_MDS",
  "CI",
] as const;

export function collectForwardedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keys: string[] = [...FORWARDED_ENV];
  if (env.CC_MODS_MOCK === "1") keys.push("HOME", "CLAUDE_CODE_SIMPLE");
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = env[key];
    if (!value) continue;
    out[key] = value;
  }
  return out;
}
