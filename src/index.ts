import { doctor, runClient, runLocal } from "./client.js";
import { configuredToken, configuredUrl, DEFAULT_WS_PORT, writeServerToken } from "./config.js";
import { runAgent } from "./agent-main.js";
import { runRemote } from "./ssh.js";
import { runServe } from "./server.js";
import pkg from "../package.json";
import { randomUUID } from "node:crypto";

const USAGE = `Usage: cc-mods-relay serve [--bind <addr>] [--port <n>] [--token <token>]
       cc-mods-relay [--url ws://host:port] [--token <token>]
       cc-mods-relay doctor
       cc-mods-relay --agent --plugin-dir <dir> [--cwd <dir>]
       cc-mods-relay --host <host> --cli <claude arguments...>

Persistent WebSocket server for Claude Code. Workspace file and shell tools execute on this machine.

  serve                 start the persistent WS server
  --url <url>           connect as a stdio ACP shim (else $CC_MODS_URL, else config url)
  --token <token>       shared secret (else $CC_MODS_TOKEN, else ~/.config/cc-mods-relay/token)
  --bind <addr>         serve bind address (default 0.0.0.0)
  --port <n>            serve port (default ${DEFAULT_WS_PORT})
  --agent --plugin-dir  stdio ACP agent (debug)
  --cwd <dir>           client working directory
  doctor                print claude / bun / herdr versions from the server /health
  --cli <args>          run claude <args> on an SSH host (legacy)
`;

function fail(message: string): never {
  console.error(`cc-mods-relay: ${message}`);
  process.exit(1);
}

function takeValue(argv: string[], i: number, flag: string): [string, number] {
  const next = argv[i + 1];
  if (!next) fail(`${flag} needs a value`);
  return [next, i + 1];
}

const argv = process.argv.slice(2);
let urlFlag: string | undefined;
let tokenFlag: string | undefined;
let bindFlag: string | undefined;
let portFlag: number | undefined;
let hostFlag: string | undefined;
let agent = false;
let serve = false;
let pluginDir = "";
let cwd: string | undefined;
let doctorFlag = false;
let cli: string[] | undefined;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg === "--cli") { cli = argv.slice(i + 1); break; }
  if (arg === "serve") serve = true;
  else if (arg === "--url") [urlFlag, i] = takeValue(argv, i, "--url");
  else if (arg.startsWith("--url=")) urlFlag = arg.slice("--url=".length);
  else if (arg === "--token") [tokenFlag, i] = takeValue(argv, i, "--token");
  else if (arg.startsWith("--token=")) tokenFlag = arg.slice("--token=".length);
  else if (arg === "--bind") [bindFlag, i] = takeValue(argv, i, "--bind");
  else if (arg.startsWith("--bind=")) bindFlag = arg.slice("--bind=".length);
  else if (arg === "--port") {
    const [raw, next] = takeValue(argv, i, "--port");
    portFlag = Number(raw);
    i = next;
  } else if (arg.startsWith("--port=")) portFlag = Number(arg.slice("--port=".length));
  else if (arg === "--host") [hostFlag, i] = takeValue(argv, i, "--host");
  else if (arg.startsWith("--host=")) hostFlag = arg.slice("--host=".length);
  else if (arg === "--agent") agent = true;
  else if (arg === "--plugin-dir") [pluginDir, i] = takeValue(argv, i, "--plugin-dir");
  else if (arg.startsWith("--plugin-dir=")) pluginDir = arg.slice("--plugin-dir=".length);
  else if (arg === "--cwd") [cwd, i] = takeValue(argv, i, "--cwd");
  else if (arg.startsWith("--cwd=")) cwd = arg.slice("--cwd=".length);
  else if (arg === "doctor") doctorFlag = true;
  else if (arg === "-h" || arg === "--help") { console.log(USAGE); process.exit(0); }
  else if (arg === "-v" || arg === "--version") { console.log(pkg.version); process.exit(0); }
  else if (arg.startsWith("-")) fail(`unknown argument ${arg}`);
  else fail(`unknown argument ${arg}`);
}

if (portFlag !== undefined && (!Number.isInteger(portFlag) || portFlag < 0)) fail("--port must be a non-negative integer");

const url = urlFlag ?? await configuredUrl();
const token = tokenFlag ?? await configuredToken();

if (serve) {
  const secret = token ?? randomUUID();
  if (!token) {
    const path = writeServerToken(secret);
    console.error(`cc-mods-relay: token written to ${path}`);
  }
  await runServe({ bind: bindFlag, port: portFlag ?? DEFAULT_WS_PORT, token: secret });
}

if (doctorFlag) {
  if (!url) fail("doctor needs --url");
  await doctor(url);
}

if (cli) {
  if (!hostFlag) fail("--cli needs --host");
  process.exit(await runRemote(hostFlag, cli, process.cwd()));
}

if (agent) {
  if (!pluginDir) fail("--agent needs --plugin-dir");
  await runAgent(pluginDir, { cwd });
} else if (url) {
  if (!token) fail("client needs --token");
  await runClient(url, token);
} else {
  await runLocal();
}
