import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { hostDirFor } from "./config.js";

export { hostDirFor };

export const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

const KEEPALIVE = ["-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];

export function rsh(): string[] {
  const custom = (Bun.env.CC_MODS_SSH || Bun.env.CC_REMOTE_SSH)?.split(/\s+/).filter(Boolean);
  if (custom?.length) return /^ssh(\.exe)?$/i.test(custom[0]!.split(/[\\/]/).pop()!) ? [...custom, ...KEEPALIVE] : custom;
  if (process.platform === "win32") return ["ssh", ...KEEPALIVE];
  const socket = `/tmp/cc-mods-${userInfo().uid}-%C`;
  return ["ssh", "-o", "ControlMaster=auto", "-o", `ControlPath=${socket}`, "-o", "ControlPersist=10m", ...KEEPALIVE];
}

export const REMOTE_PATH = `PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"`;

export async function remoteHome(host: string): Promise<string> {
  const probe = Bun.spawn([...rsh(), "-T", host, 'printf %s "$HOME"'], { stdout: "pipe", stderr: "pipe" });
  const home = (await new Response(probe.stdout).text()).trim();
  if ((await probe.exited) !== 0 || !home.startsWith("/")) throw new Error(`could not resolve $HOME on ${host}`);
  return home;
}

const FORWARDED_ENV = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "CC_MODS_DEBUG",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_TUI_BACKEND",
  "CLAUDE_TUI_HERDR_SESSION",
  "CLAUDE_TUI_HERDR_BIN",
  "CLAUDE_TUI_HERDR_HOME",
  "CC_MODS_MOCK",
  "FORK_GATE",
  "DISABLE_TELEMETRY",
  "DISABLE_ERROR_REPORTING",
  "DISABLE_AUTOUPDATER",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "CLAUDE_CODE_DISABLE_CLAUDE_MDS",
  "CI",
] as const;

export function remoteEnvPrefix(env: NodeJS.ProcessEnv = process.env): string {
  const keys: string[] = [...FORWARDED_ENV];
  if (env.CC_MODS_MOCK === "1") keys.push("HOME", "CLAUDE_CODE_SIMPLE");
  const parts: string[] = [];
  for (const key of keys) {
    const value = env[key];
    if (!value) continue;
    parts.push(`${key}=${quote(value)}`);
  }
  return parts.length ? `${parts.join(" ")} ` : "";
}

export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** Reverse-forward a local mock API onto a real Mini. Skip on localhost — the port is already bound. */
export function mockForwardArgs(host: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (isLoopbackHost(host)) return [];
  const match = /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/i.exec(env.ANTHROPIC_BASE_URL ?? "");
  if (!match) return [];
  const port = match[1]!;
  return ["-R", `127.0.0.1:${port}:127.0.0.1:${port}`];
}

export function acpTunnelArgs(
  host: string,
  port: number,
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const [ssh, ...flags] = rsh();
  const forwards = isLoopbackHost(host)
    ? []
    : ["-R", `127.0.0.1:${port}:127.0.0.1:${port}`, ...mockForwardArgs(host, env)];
  return [
    ssh!,
    ...flags,
    "-T",
    ...(forwards.length ? ["-o", "ExitOnForwardFailure=yes", ...forwards] : []),
    host,
    command,
  ];
}

export function spawnAcpTunnel(
  host: string,
  port: number,
  command: string,
  inheritErr = true,
  env: NodeJS.ProcessEnv = process.env,
) {
  const argv = acpTunnelArgs(host, port, command, env);
  return spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", inheritErr ? "inherit" : "pipe"] });
}

export function tunnelAcp(host: string, port: number, command: string): Promise<number> {
  const child = spawnAcpTunnel(host, port, command);
  process.stdin.pipe(child.stdin!);
  child.stdout!.pipe(process.stdout);
  return new Promise((done) => child.on("exit", (code) => done(code ?? 1)));
}

export function runRemote(host: string, args: string[], cwd: string): Promise<number> {
  const dir = `"$HOME"/${quote(hostDirFor(cwd))}`;
  const remote = `mkdir -p ${dir} && cd ${dir} && ${REMOTE_PATH} exec claude ${args.map(quote).join(" ")}`;
  const [ssh, ...flags] = rsh();
  const tty = process.stdin.isTTY && process.stdout.isTTY ? "-t" : "-T";
  const child = spawn(ssh!, [...flags, tty, host, remote], { stdio: "inherit" });
  return new Promise((done) => child.on("exit", (code) => done(code ?? 1)));
}
