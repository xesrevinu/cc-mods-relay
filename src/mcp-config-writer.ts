import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import type { McpServer, HttpHeader, EnvVariable } from "@agentclientprotocol/sdk/unstable";

export type ClaudeMcpEntry =
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> }
  | { command: string; args?: string[]; env?: Record<string, string> };

export interface ClaudeMcpConfig {
  mcpServers: Record<string, ClaudeMcpEntry>;
}

function pairsToObject(pairs: ReadonlyArray<HttpHeader | EnvVariable>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, value } of pairs) {
    out[name] = value;
  }
  return out;
}

export function claudeMcpServerName(name: string): string {
  return name === "workspace" ? "localws" : name;
}

export function translateMcpServers(servers: readonly McpServer[] | undefined): ClaudeMcpConfig {
  const mcpServers: Record<string, ClaudeMcpEntry> = {};
  if (!servers) {
    return { mcpServers };
  }

  for (const server of servers) {
    if ("type" in server) {
      if (server.type === "http" || server.type === "sse") {
        const entry: ClaudeMcpEntry = { type: server.type, url: server.url };
        if (server.headers.length > 0) {
          entry.headers = pairsToObject(server.headers);
        }
        mcpServers[claudeMcpServerName(server.name)] = entry;
      } else {
        console.error(
          `[mcp-config-writer] dropping ACP-transport MCP server ${JSON.stringify(server.name)}: ` +
            `no --mcp-config equivalent (ACP-channel transport is not supported by the claude CLI).`,
        );
      }
      continue;
    }

    const entry: ClaudeMcpEntry = { command: server.command };
    if (server.args.length > 0) {
      entry.args = [...server.args];
    }
    if (server.env.length > 0) {
      entry.env = pairsToObject(server.env);
    }
    mcpServers[claudeMcpServerName(server.name)] = entry;
  }

  return { mcpServers };
}

async function durableWrite0600(filePath: string, text: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.fork-tmp-${process.pid}-${Date.now()}`);
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(tmp, "w", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tmp, filePath);
    await fs.chmod(filePath, 0o600);
    try {
      const dirHandle = await fs.open(dir, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
    }
  } catch (err) {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
      }
    }
    try {
      await fs.rm(tmp, { force: true });
    } catch {
    }
    throw err;
  }
}

export async function writeMcpScratch(config: ClaudeMcpConfig): Promise<string> {
  const filePath = path.join(os.tmpdir(), `fork-acp-mcp-${randomUUID()}.json`);
  const text = `${JSON.stringify(config, null, 2)}\n`;
  await durableWrite0600(filePath, text);
  return filePath;
}

export async function removeMcpScratch(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}
