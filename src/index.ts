import { doctor, runClient, runLocal } from "./client.js";
import { configuredHost } from "./config.js";
import { runAgent } from "./agent-main.js";
import { runRemote } from "./ssh.js";
import pkg from "../package.json";

const USAGE = `Usage: cc-mods-relay [--host <host>]
       cc-mods-relay --agent --plugin-dir <dir>
       cc-mods-relay [--host <host>] doctor
       cc-mods-relay [--host <host>] --cli <claude arguments...>

Run Claude Code on an SSH host. Workspace file and shell tools execute on this machine.

  --host <host>         ssh destination (else $CC_MODS_HOST, else ~/.config/cc-mods-relay/host)
  --agent --plugin-dir  ACP agent on this machine (what ssh launches on the host)
  doctor                print claude / bun / herdr versions on the host
  --cli <args>          run claude <args> on the host
`;

function fail(message: string): never {
  console.error(`cc-mods-relay: ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
let hostFlag: string | undefined;
let agent = false;
let pluginDir = "";
let doctorFlag = false;
let cli: string[] | undefined;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg === "--cli") { cli = argv.slice(i + 1); break; }
  if (arg === "--host") hostFlag = argv[++i] ?? fail("--host needs a value");
  else if (arg.startsWith("--host=")) hostFlag = arg.slice("--host=".length);
  else if (arg === "--agent") agent = true;
  else if (arg === "--plugin-dir") pluginDir = argv[++i] ?? fail("--plugin-dir needs a value");
  else if (arg.startsWith("--plugin-dir=")) pluginDir = arg.slice("--plugin-dir=".length);
  else if (arg === "doctor") doctorFlag = true;
  else if (arg === "-h" || arg === "--help") { console.log(USAGE); process.exit(0); }
  else if (arg === "-v" || arg === "--version") { console.log(pkg.version); process.exit(0); }
  else if (arg.startsWith("-")) fail(`unknown argument ${arg}`);
}

const host = hostFlag ?? await configuredHost();
if (doctorFlag) {
  if (!host) fail("doctor needs --host");
  await doctor(host);
}
if (cli) {
  if (!host) fail("--cli needs --host");
  process.exit(await runRemote(host, cli, process.cwd()));
}
if (agent) {
  if (!pluginDir) fail("--agent needs --plugin-dir");
  await runAgent(pluginDir);
} else if (host) {
  await runClient(host);
} else {
  await runLocal();
}
