import type { ChildProcess } from "node:child_process";
import { debug } from "./debug.js";
import { stagePlugin, syncProjectClaude, uploadAgent, uploadPlugin, type Endpoint } from "./launch.js";
import { startRelay } from "./relay.js";
import { hostDirFor, quote, REMOTE_PATH, remoteEnvPrefix, remoteHome, rsh, spawnAcpTunnel } from "./ssh.js";
import { runAgent } from "./agent-main.js";

export async function openRemote(
  host: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; inheritErr?: boolean } = {},
) {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const relay = startRelay();
  const home = await remoteHome(host);
  const tuiRoot = `${home}/${hostDirFor(cwd)}`;
  const endpoint: Endpoint = { url: `ws://127.0.0.1:${relay.port}/tools`, token: relay.token, cwd, tuiRoot };
  relay.bind("", cwd, tuiRoot);
  debug("open remote", { host, cwd, tuiRoot, port: relay.port });
  await syncProjectClaude(host, cwd, tuiRoot);
  const pluginDir = await uploadPlugin(host, endpoint);
  const agentJs = await uploadAgent(host);
  const remote = `mkdir -p ${quote(tuiRoot)} && cd ${quote(tuiRoot)} && ${REMOTE_PATH} exec env ${remoteEnvPrefix(env)}bun ${quote(agentJs)} --plugin-dir ${quote(pluginDir)}`;
  const child = spawnAcpTunnel(host, relay.port, remote, opts.inheritErr !== false, env);
  return { relay, child, tuiRoot, pluginDir, cwd };
}

export async function runClient(host: string) {
  const opened = await openRemote(host, { inheritErr: true });
  process.stdin.pipe(opened.child.stdin!);
  opened.child.stdout!.pipe(process.stdout);
  const code = await new Promise<number>((done) => opened.child.on("exit", (exit) => done(exit ?? 1)));
  opened.relay.stop();
  process.exit(code);
}

export async function prepareLocal(cwd = process.cwd(), tuiRoot = cwd) {
  const relay = startRelay();
  const endpoint: Endpoint = { url: relay.url, token: relay.token, cwd, tuiRoot };
  relay.bind("", cwd, tuiRoot);
  const pluginDir = await stagePlugin(endpoint);
  return { relay, pluginDir, cwd, tuiRoot };
}

export async function runLocal() {
  const { relay, pluginDir } = await prepareLocal();
  process.on("exit", () => relay.stop());
  await runAgent(pluginDir);
}

export async function doctor(host: string) {
  const proc = Bun.spawn(
    [...rsh(), "-T", host, `${REMOTE_PATH} sh -c 'claude --version; bun --version; herdr --version'`],
    { stdout: "inherit", stderr: "inherit" },
  );
  process.exit(await proc.exited);
}

export type { ChildProcess };
