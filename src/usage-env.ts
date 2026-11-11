export function usageUpdateEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.USAGE_UPDATE !== "0" && env.USAGE_UPDATE !== "false";
}
