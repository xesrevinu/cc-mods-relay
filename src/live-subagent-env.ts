export function liveSubagentWatchEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.FORK_LIVE_SUBAGENT_WATCH !== "0" && env.FORK_LIVE_SUBAGENT_WATCH !== "false";
}
