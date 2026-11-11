export function liveDiffEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.LIVE_DIFF !== "0" && env.LIVE_DIFF !== "false";
}
