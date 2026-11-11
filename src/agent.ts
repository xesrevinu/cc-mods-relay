import { runAgent } from "./agent-main.js";

function fail(message: string): never {
  console.error(`cc-mods-relay: ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
let pluginDir = "";
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg === "--plugin-dir") pluginDir = argv[++i] ?? fail("--plugin-dir needs a value");
  else if (arg.startsWith("--plugin-dir=")) pluginDir = arg.slice("--plugin-dir=".length);
  else fail(`unknown argument ${arg}`);
}
if (!pluginDir) fail("agent needs --plugin-dir");
await runAgent(pluginDir);
