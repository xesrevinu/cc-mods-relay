import { existsSync } from "node:fs";
import { join } from "node:path";
import { defaultStartEngine, type StartEngine } from "./acp-agent.js";
import { createBunPtySpawn } from "./bun-pty-backend.js";
import { ENVIRONMENT_FILE } from "./environment.js";
import { createHerdrSpawn } from "./herdr-backend.js";
import { quote } from "./ssh.js";
import { resolveTerminalBackendName, type TerminalSpawn } from "./terminal-backend.js";

export function withPlugin(command: string, pluginDir: string): string {
  if (!pluginDir.startsWith("/") || /["$`\n\r]/.test(pluginDir)) {
    throw new Error(`cc-mods-relay: invalid plugin dir ${JSON.stringify(pluginDir)}`);
  }
  const flags = [`--plugin-dir ${quote(pluginDir)}`];
  const envFile = join(pluginDir, ENVIRONMENT_FILE);
  if (existsSync(envFile)) flags.push(`--append-system-prompt-file ${quote(envFile)}`);
  const flag = flags.join(" ");
  const next = command.replace(/(^|[\s;|&])claude(?=[\s]|$)/g, `$1claude ${flag}`);
  if (next === command) throw new Error("cc-mods-relay: TUI command does not contain claude");
  return next;
}

export function stackSpawn(base: TerminalSpawn, pluginDir: string): TerminalSpawn {
  return (file, args, options) => {
    const next = [...args];
    if ((next[0] === "-lc" || next[0] === "-c") && typeof next[1] === "string") next[1] = withPlugin(next[1], pluginDir);
    return base(file, next, options);
  };
}

export async function stackedEngine(pluginDir: string, herdrSession: string): Promise<StartEngine> {
  const base = resolveTerminalBackendName() === "bun-pty"
    ? createBunPtySpawn()
    : createHerdrSpawn({ herdrSession });
  const spawn = stackSpawn(base, pluginDir);
  return (args) => defaultStartEngine({ ...args, spawn });
}
