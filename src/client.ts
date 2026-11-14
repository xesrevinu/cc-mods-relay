import { stagePlugin, type Endpoint } from "./launch.js";
import { startRelay } from "./relay.js";

export { doctor, runClient, runLocal } from "./client-ws.js";

export async function prepareLocal(cwd = process.cwd(), tuiRoot = cwd) {
  const relay = startRelay();
  const endpoint: Endpoint = { url: relay.url, token: relay.token, cwd, tuiRoot };
  relay.bind("", cwd, tuiRoot);
  const pluginDir = await stagePlugin(endpoint);
  return { relay, pluginDir, cwd, tuiRoot };
}
