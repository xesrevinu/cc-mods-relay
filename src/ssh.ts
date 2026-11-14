import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { hostDirFor } from "./config.js";
import { collectForwardedEnv } from "./forwarded-env.js";

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

function isSafeAbsDir(path: string): boolean {
  return path.startsWith("/") && !/[\n\r]/.test(path);
}

/**
 * Directory the Mini TUI process should `cd` into. Prefer the client's pwd so
 * Claude Code's Environment matches the client path, not the TUI host `$HOME/Workspace/...`.
 * Falls back to `hostDirFor` when the client path cannot be created remotely.
 */
export async function remoteTuiRoot(host: string, clientCwd: string): Promise<string> {
  const fallback = `${await remoteHome(host)}/${hostDirFor(clientCwd)}`;
  if (!isSafeAbsDir(clientCwd)) return fallback;
  const probe = Bun.spawn(
    [
      ...rsh(),
      "-T",
      host,
      `mkdir -p ${quote(clientCwd)} && { test -e ${quote(clientCwd)}/.git || git init -q ${quote(clientCwd)}; } && test -d ${quote(clientCwd)}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if ((await probe.exited) === 0) return clientCwd;
  return fallback;
}

export function remoteEnvPrefix(env: NodeJS.ProcessEnv = process.env): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(collectForwardedEnv(env))) {
    parts.push(`${key}=${quote(value)}`);
  }
  return parts.length ? `${parts.join(" ")} ` : "";
}

export function runRemote(host: string, args: string[], cwd: string): Promise<number> {
  const dir = `"$HOME"/${quote(hostDirFor(cwd))}`;
  const remote = `mkdir -p ${dir} && cd ${dir} && ${REMOTE_PATH} exec claude ${args.map(quote).join(" ")}`;
  const [ssh, ...flags] = rsh();
  const tty = process.stdin.isTTY && process.stdout.isTTY ? "-t" : "-T";
  const child = spawn(ssh!, [...flags, tty, host, remote], { stdio: "inherit" });
  return new Promise((done) => child.on("exit", (code) => done(code ?? 1)));
}
