import { join } from "node:path";
import { configuredToken, configuredUrl } from "../src/config.js";
import { AcpTestClient } from "../test/acp-client.js";

const INDEX = join(import.meta.dir, "../src/index.ts");

export function envRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export async function liveEndpoint(): Promise<{ url: string; token: string }> {
  const url = await configuredUrl();
  const token = await configuredToken();
  if (!url) throw new Error("cc-mods-relay: set $CC_MODS_URL or ~/.config/cc-mods-relay/url");
  if (!token) throw new Error("cc-mods-relay: set $CC_MODS_TOKEN or ~/.config/cc-mods-relay/token");
  return { url, token };
}

export async function spawnLiveShim(cwd: string, env: NodeJS.ProcessEnv): Promise<AcpTestClient> {
  const { url, token } = await liveEndpoint();
  return AcpTestClient.spawn(["bun", INDEX, "--url", url, "--token", token], { cwd, env: envRecord(env) });
}

export function hostFromWsUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
