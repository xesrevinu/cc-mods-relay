import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";

export async function applyManagedPolicyEnv(
  resolve: typeof resolveSettings = resolveSettings,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  let policy: Awaited<ReturnType<typeof resolveSettings>>;
  try {
    policy = await resolve({ settingSources: [] });
  } catch (error) {
    console.error("Failed to resolve managed policy settings:", error);
    return;
  }
  for (const [key, value] of Object.entries(policy.effective.env ?? {})) {
    env[key] = value;
  }
}
