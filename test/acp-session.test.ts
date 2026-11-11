import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ClaudeAcpAgent,
  type AcpClient,
  type StartEngineArgs,
  type StoredSessionInfo,
} from "../src/acp-agent.js";
import { BUILTIN_COMMANDS } from "../src/command-catalog.js";
import { MODEL_CATALOG } from "../src/model-catalog.js";
import type { EngineTerminal } from "../src/terminal-backend.js";
import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";

const silent = { log() {}, error() {} };

function fakePty(): EngineTerminal {
  return {
    pid: 1,
    write() {},
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    kill() {},
    resize() {},
  };
}

function mockClient(updates: SessionNotification[] = []): AcpClient {
  return {
    sessionUpdate: async (note) => {
      updates.push(note);
    },
    requestPermission: async () => ({
      outcome: { outcome: "cancelled" },
    }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
    createElicitation: async () => ({ action: "cancel" }),
  };
}

function textOf(updates: SessionNotification[]): string {
  return updates
    .flatMap((note) => {
      const update = note.update as { sessionUpdate?: string; content?: { type?: string; text?: string } };
      if (update.sessionUpdate !== "agent_message_chunk") return [];
      return update.content?.type === "text" ? [update.content.text ?? ""] : [];
    })
    .join("");
}

function slashPrompt(sessionId: string, text: string) {
  return { sessionId, prompt: [{ type: "text" as const, text }] };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function harness(opts: {
  stored?: StoredSessionInfo[];
  deleted?: string[];
} = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "cc-mods-acp-"));
  const updates: SessionNotification[] = [];
  const starts: StartEngineArgs[] = [];
  const deleted = opts.deleted ?? [];
  const agent = new ClaudeAcpAgent(mockClient(updates), silent, {
    startEngine: (args) => {
      starts.push(args);
      const sessionId = args.sessionId ?? randomUUID();
      return { sessionId, pty: fakePty(), cwd: args.cwd };
    },
    modelCatalogSource: async () => MODEL_CATALOG,
    discoverCommands: () => [...BUILTIN_COMMANDS],
    discoverAgents: () => [],
    getSessionInfo: async () => undefined,
    listStoredSessions: async () => opts.stored ?? [],
    deleteStoredSession: async (sessionId) => {
      deleted.push(sessionId);
    },
    getMessages: async () => [{ type: "permission-mode", permissionMode: "plan" }],
    fastModeProbe: () => false,
  });
  return { agent, cwd, updates, starts, deleted };
}

const live: ClaudeAcpAgent[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((agent) => agent.dispose()));
});

test("initialize advertises the session methods an ACP client uses", async () => {
  const { agent } = harness();
  live.push(agent);
  const init = await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  expect(init.protocolVersion).toBe(1);
  expect(init.agentCapabilities?.sessionCapabilities).toMatchObject({
    fork: {},
    list: {},
    resume: {},
    close: {},
    delete: {},
  });
  expect(init.agentCapabilities?.loadSession).toBe(true);
});

test("an ACP client can create, slash, fork, resume, list, close, and delete", async () => {
  const { agent, cwd, updates, starts, deleted } = harness();
  live.push(agent);

  await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });

  const created = await agent.newSession({ cwd, mcpServers: [] });
  expect(created.sessionId).toBeTruthy();
  expect(created.modes?.availableModes?.some((m) => m.id === "plan")).toBe(true);
  expect(created.configOptions?.some((o) => o.id === "effort")).toBe(true);

  await flush();
  const commandNames = updates
    .map((n) => n.update)
    .filter((u) => u.sessionUpdate === "available_commands_update")
    .flatMap((u) => ("availableCommands" in u ? u.availableCommands.map((c) => c.name) : []));
  expect(commandNames.sort()).toEqual(["context", "effort", "fast", "model", "usage"]);

  updates.length = 0;
  const usage = await agent.prompt(slashPrompt(created.sessionId, "/usage"));
  expect(usage.stopReason).toBe("end_turn");
  expect(textOf(updates)).toContain("tokens");
  expect(updates.some((n) => n.update.sessionUpdate === "usage_update")).toBe(true);

  updates.length = 0;
  const context = await agent.prompt(slashPrompt(created.sessionId, "/context"));
  expect(context.stopReason).toBe("end_turn");
  expect(textOf(updates)).toContain(`cwd: `);
  expect(textOf(updates)).toContain("mode: default");

  updates.length = 0;
  const effortSlash = await agent.prompt(slashPrompt(created.sessionId, "/effort high"));
  expect(effortSlash.stopReason).toBe("end_turn");
  expect(textOf(updates)).toContain("effort: high");

  updates.length = 0;
  const modelSlash = await agent.prompt(slashPrompt(created.sessionId, "/model sonnet"));
  expect(modelSlash.stopReason).toBe("end_turn");
  expect(textOf(updates)).toContain("model: sonnet");

  updates.length = 0;
  const fastSlash = await agent.prompt(slashPrompt(created.sessionId, "/fast on"));
  expect(fastSlash.stopReason).toBe("end_turn");
  expect(textOf(updates).length).toBeGreaterThan(0);

  await agent.setSessionMode({ sessionId: created.sessionId, modeId: "plan" });
  updates.length = 0;
  await agent.prompt(slashPrompt(created.sessionId, "/context"));
  expect(textOf(updates)).toContain("mode: plan");

  const config = await agent.setSessionConfigOption({
    sessionId: created.sessionId,
    configId: "effort",
    value: "low",
  });
  expect(config.configOptions?.some((o) => o.id === "effort" && o.currentValue === "low")).toBe(true);

  const beforeFork = starts.length;
  const forked = await agent.unstable_forkSession({
    sessionId: created.sessionId,
    cwd,
    mcpServers: [],
  });
  expect(forked.sessionId).toBeTruthy();
  expect(forked.sessionId).not.toBe(created.sessionId);
  const forkStart = starts[beforeFork];
  expect(forkStart).toMatchObject({
    fork: true,
    resume: false,
    resumeFrom: created.sessionId,
    sessionId: forked.sessionId,
  });

  const listed = await agent.listSessions({ cwd });
  const ids = listed.sessions.map((s) => s.sessionId);
  expect(ids).toContain(created.sessionId);
  expect(ids).toContain(forked.sessionId);

  const resumesBefore = starts.length;
  const resumed = await agent.resumeSession({
    sessionId: created.sessionId,
    cwd,
    mcpServers: [],
  });
  expect(resumed.modes?.currentModeId).toBeTruthy();
  expect(starts.length).toBe(resumesBefore);

  await agent.closeSession({ sessionId: created.sessionId });
  await expect(agent.prompt(slashPrompt(created.sessionId, "/usage"))).rejects.toThrow(/Session not found/);

  const resumeAfterClose = starts.length;
  const reopened = await agent.resumeSession({
    sessionId: created.sessionId,
    cwd,
    mcpServers: [],
  });
  expect(reopened.modes).toBeDefined();
  expect(starts[resumeAfterClose]).toMatchObject({
    resume: true,
    fork: false,
    sessionId: created.sessionId,
  });

  await agent.deleteSession({ sessionId: forked.sessionId });
  expect(deleted).toContain(forked.sessionId);
  const afterDelete = await agent.listSessions({ cwd });
  expect(afterDelete.sessions.map((s) => s.sessionId)).not.toContain(forked.sessionId);
});

test("session/list includes live ACP sessions even when disk listing is empty", async () => {
  const stored: StoredSessionInfo[] = [
    {
      sessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      cwd: "/tmp/other",
      summary: "old chat",
      lastModified: Date.parse("2026-01-01T00:00:00Z"),
    },
  ];
  const { agent, cwd } = harness({ stored });
  live.push(agent);
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const created = await agent.newSession({ cwd, mcpServers: [] });

  const all = await agent.listSessions({});
  expect(all.sessions.map((s) => s.sessionId)).toContain(created.sessionId);
  expect(all.sessions.map((s) => s.sessionId)).toContain(stored[0]!.sessionId);

  const filtered = await agent.listSessions({ cwd });
  expect(filtered.sessions.map((s) => s.sessionId)).toEqual([created.sessionId]);
});
