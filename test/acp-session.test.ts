import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ClaudeAcpAgent,
  parseGrokInterject,
  parseGrokSessionId,
  parseGrokSessionRename,
  permissionModeFromClientMeta,
  type AcpClient,
  type StartEngineArgs,
  type StoredSessionInfo,
} from "../src/acp-agent.js";
import type { PlanUsageSource } from "../src/plan-usage.js";
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

function mockClient(
  updates: SessionNotification[] = [],
  extNotes: Array<{ method: string; params: unknown }> = [],
): AcpClient {
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
    extNotify: async (method, params) => {
      extNotes.push({ method, params });
    },
  };
}

function textOf(updates: SessionNotification[]): string {
  return updates
    .flatMap((note) => {
      const update = note.update as { sessionUpdate?: string; content?: { type?: string; text?: string } };
      if (update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "user_message_chunk") {
        return [];
      }
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

async function waitForTurn(agent: ClaudeAcpAgent, sessionId: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (agent.sessions[sessionId]?.turnCancel) return;
    await flush();
  }
  throw new Error(`turn did not start for ${sessionId}`);
}

function harness(opts: {
  stored?: StoredSessionInfo[];
  deleted?: string[];
  renamed?: Array<{ sessionId: string; title: string; dir?: string }>;
  getMessages?: (sessionId: string, options?: { dir?: string }) => Promise<Array<{ uuid?: string; [k: string]: unknown }>>;
  getPlanUsage?: PlanUsageSource;
  forkHistoryWaitMs?: number;
  writes?: string[];
  immediate?: boolean;
  discoverAgents?: () => Array<{ value: string; displayName: string }>;
} = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "cc-mods-acp-"));
  const updates: SessionNotification[] = [];
  const extNotes: Array<{ method: string; params: unknown }> = [];
  const starts: StartEngineArgs[] = [];
  const listedDirs: Array<string | undefined> = [];
  const messageDirs: Array<string | undefined> = [];
  const deleted = opts.deleted ?? [];
  const renamed = opts.renamed ?? [];
  const writes = opts.writes ?? [];
  const agent = new ClaudeAcpAgent(mockClient(updates, extNotes), silent, {
    startEngine: (args) => {
      starts.push(args);
      const sessionId = args.sessionId ?? randomUUID();
      const pty = fakePty();
      const innerWrite = pty.write.bind(pty);
      pty.write = (data: string) => {
        writes.push(data);
        innerWrite(data);
      };
      return { sessionId, pty, cwd: args.cwd };
    },
    modelCatalogSource: async () => MODEL_CATALOG,
    discoverCommands: () => [...BUILTIN_COMMANDS],
    discoverAgents: opts.discoverAgents ?? (() => []),
    getSessionInfo: async () => undefined,
    listStoredSessions: async ({ dir }) => {
      listedDirs.push(dir);
      return opts.stored ?? [];
    },
    deleteStoredSession: async (sessionId) => {
      deleted.push(sessionId);
    },
    renameStoredSession: async (sessionId, title, options) => {
      renamed.push({ sessionId, title, dir: options?.dir });
    },
    getMessages: async (sessionId, options) => {
      messageDirs.push(options?.dir);
      if (opts.getMessages) return opts.getMessages(sessionId, options);
      return [{ type: "permission-mode", permissionMode: "plan" }];
    },
    fastModeProbe: () => false,
    getPlanUsage: opts.getPlanUsage ?? (async () => undefined),
    forkHistoryWaitMs: opts.forkHistoryWaitMs ?? 0,
    ...(opts.immediate
      ? {
          schedule: (fn: () => void, ms: number) => {
            if (ms <= 200) {
              fn();
              return () => {};
            }
            const id = setTimeout(fn, ms);
            return () => clearTimeout(id);
          },
          cancelEscalationMs: 0,
        }
      : {}),
  });
  return { agent, cwd, updates, extNotes, starts, deleted, listedDirs, messageDirs, renamed, writes };
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
    title: {},
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
  expect(starts[0]?.sessionId).toBe(created.sessionId);
  expect(created.modes?.availableModes?.some((m) => m.id === "plan")).toBe(true);
  expect(created.configOptions?.some((o) => o.id === "effort")).toBe(true);

  await flush();
  const commandNames = updates
    .map((n) => n.update)
    .filter((u) => u.sessionUpdate === "available_commands_update")
    .flatMap((u) => ("availableCommands" in u ? u.availableCommands.map((c) => c.name) : []));
  expect(commandNames.sort()).toEqual(["context", "effort", "fast", "model", "rename", "usage"]);

  updates.length = 0;
  const usage = await agent.prompt(slashPrompt(created.sessionId, "/usage"));
  expect(usage.stopReason).toBe("end_turn");
  expect(textOf(updates)).toContain("Session");
  expect(textOf(updates)).toContain("Current session");
  expect(textOf(updates)).toContain("tokens");
  expect(updates.some((n) => n.update.sessionUpdate === "usage_update")).toBe(true);

  updates.length = 0;
  const context = await agent.prompt(slashPrompt(created.sessionId, "/context"));
  expect(context.stopReason).toBe("end_turn");
  expect(textOf(updates)).toContain("Context Usage");
  expect(textOf(updates)).toContain("cwd:");
  expect(textOf(updates)).toMatch(/mode:\s+bypassPermissions/);
  expect(textOf(updates)).toContain("Token buckets");

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
  expect(textOf(updates)).toMatch(/mode:\s+plan/);

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

test("session/update echoes PromptRequest _meta.promptId", async () => {
  const { agent, cwd, updates } = harness();
  live.push(agent);
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const created = await agent.newSession({ cwd, mcpServers: [] });
  updates.length = 0;
  await agent.prompt({
    sessionId: created.sessionId,
    prompt: [{ type: "text", text: "/usage" }],
    _meta: { promptId: "client-prompt-1" },
  });
  expect(updates.length).toBeGreaterThan(0);
  expect(
    updates.every((n) => (n._meta as { promptId?: string } | undefined)?.promptId === "client-prompt-1"),
  ).toBe(true);
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

test("session/list maps the client's cwd filter onto the host TUI cwd", async () => {
  const storedId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const stored: StoredSessionInfo[] = [
    {
      sessionId: storedId,
      cwd: process.cwd(),
      summary: "host transcript",
      lastModified: Date.parse("2026-01-02T00:00:00Z"),
    },
  ];
  const { agent, cwd, listedDirs } = harness({ stored });
  live.push(agent);
  await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });

  const listed = await agent.listSessions({ cwd });
  expect(listedDirs).toContain(process.cwd());
  const row = listed.sessions.find((s) => s.sessionId === storedId);
  expect(row).toBeDefined();
  expect(row?.cwd).toBe(cwd);
});

test("session/load replays history for a live session without spawning again", async () => {
  const { agent, cwd, updates, starts, messageDirs } = harness({
    getMessages: async () => [
      { uuid: "hist-user", type: "user", message: { role: "user", content: "old question" } },
      { uuid: "hist-asst", type: "assistant", message: { role: "assistant", content: "old answer" } },
    ],
  });
  live.push(agent);
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const created = await agent.newSession({ cwd, mcpServers: [] });
  const spawned = starts.length;

  updates.length = 0;
  const loaded = await agent.loadSession({
    sessionId: created.sessionId,
    cwd: `${cwd}-other`,
    mcpServers: [],
  });
  expect(loaded.sessionId).toBe(created.sessionId);
  expect(starts.length).toBe(spawned);
  expect(messageDirs).toContain(cwd);
  expect(textOf(updates)).toContain("old question");
  expect(textOf(updates)).toContain("old answer");

  updates.length = 0;
  await agent.loadSession({ sessionId: created.sessionId, cwd, mcpServers: [] });
  expect(textOf(updates)).toContain("old answer");
});

test("session/set_title persists and pushes session_info_update", async () => {
  const { agent, cwd, updates, renamed } = harness();
  live.push(agent);
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const created = await agent.newSession({ cwd, mcpServers: [] });
  updates.length = 0;

  const result = await agent.setSessionTitle({
    sessionId: created.sessionId,
    title: "  Demo title  ",
  });
  expect(result.title).toBe("Demo title");
  expect(renamed).toEqual([{ sessionId: created.sessionId, title: "Demo title", dir: cwd }]);
  expect(
    updates.some(
      (n) =>
        n.update.sessionUpdate === "session_info_update" &&
        "title" in n.update &&
        n.update.title === "Demo title",
    ),
  ).toBe(true);

  const listed = await agent.listSessions({ cwd });
  expect(listed.sessions.find((s) => s.sessionId === created.sessionId)?.title).toBe("Demo title");
});

test("x.ai/session/rename and /rename slash retitle the live session", async () => {
  const { agent, cwd, updates, renamed } = harness();
  live.push(agent);
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const created = await agent.newSession({ cwd, mcpServers: [] });

  expect(parseGrokSessionRename({ sessionId: created.sessionId, title: "From grok" })).toEqual({
    sessionId: created.sessionId,
    title: "From grok",
    cwd: undefined,
    resetToAuto: false,
  });

  updates.length = 0;
  await agent.handleGrokSessionRename({
    sessionId: created.sessionId,
    title: "From grok",
    cwd,
  });
  expect(renamed.at(-1)).toMatchObject({ sessionId: created.sessionId, title: "From grok" });

  updates.length = 0;
  const slash = await agent.prompt(slashPrompt(created.sessionId, "/rename Slash title"));
  expect(slash.stopReason).toBe("end_turn");
  expect(textOf(updates)).toContain("renamed: Slash title");
  expect(renamed.at(-1)).toMatchObject({ sessionId: created.sessionId, title: "Slash title" });

  await expect(
    agent.handleGrokSessionRename({ sessionId: created.sessionId, title: "", resetToAuto: true }),
  ).rejects.toThrow(/resetToAuto/);
});

test("/usage intercept includes Claude plan rate-limit windows", async () => {
  const { agent, cwd, updates } = harness({
    getPlanUsage: async () => ({
      windows: [
        {
          label: "Current session",
          utilization: 12,
          resetsAt: "2026-01-15T16:30:00Z",
        },
        {
          label: "Current week (all models)",
          utilization: 34,
          resetsAt: "2026-01-20T18:00:00Z",
        },
        {
          label: "Current week (Fable)",
          utilization: 5,
          resetsAt: "2026-01-20T18:00:00Z",
        },
      ],
      mcpServers: [
        { name: "docs", pct: 60 },
        { name: "search", pct: 20 },
      ],
    }),
  });
  live.push(agent);
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const created = await agent.newSession({ cwd, mcpServers: [] });
  updates.length = 0;
  const usage = await agent.prompt(slashPrompt(created.sessionId, "/usage"));
  expect(usage.stopReason).toBe("end_turn");
  const text = textOf(updates);
  expect(text).toMatch(/\d+% used/);
  expect(text).toContain("Current week (Fable)");
  expect(text).toMatch(/docs \d+%/);
  expect(updates.some((n) => n.update.sessionUpdate === "usage_update")).toBe(true);
});

test("x.ai/session/info and session/usage expose live occupancy", async () => {
  const { agent, cwd } = harness();
  live.push(agent);
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const created = await agent.newSession({ cwd, mcpServers: [] });
  expect(parseGrokSessionId({ sessionId: created.sessionId })).toEqual({ sessionId: created.sessionId });

  const liveSession = agent.sessions[created.sessionId];
  liveSession.mcpServers = [{ name: "cc" }] as typeof liveSession.mcpServers;
  liveSession.lastContextUsed = 10_000;
  liveSession.contextWindowSize = 1_000_000;
  liveSession.accumulatedUsage = {
    inputTokens: 1_200,
    outputTokens: 40,
    cachedReadTokens: 300,
    cachedWriteTokens: 20,
  };
  liveSession.lastCostUsd = 0.01;

  const info = await agent.handleGrokSessionInfo({ sessionId: created.sessionId });
  expect(info.result.sessionId).toBe(created.sessionId);
  const context = info.result.context as { used: number; total: number; usagePct: number; usageCategories: Array<{ label: string }> };
  expect(context.used).toBeGreaterThan(0);
  expect(context.total).toBeGreaterThan(context.used);
  expect(context.usagePct).toBeGreaterThanOrEqual(0);
  expect(context.messageTokens).toBeGreaterThan(0);
  expect(context.usageCategories.some((row) => row.label === "MCP servers")).toBe(true);

  liveSession.lastMessages = [
    {
      contextUsage: {
        total_tokens: 100_000,
        raw_max_tokens: 1_000_000,
        percentage: 10,
        categories: [
          { name: "System prompt", tokens: 3_000, kind: "used" },
          { name: "Messages", tokens: 80_000, kind: "used" },
          { name: "System tools", tokens: 2_000, kind: "used" },
          { name: "MCP tools", tokens: 4_000, kind: "used" },
          { name: "Free space", tokens: 900_000, kind: "free" },
        ],
        mcp_tools: [{ name: "a" }, { name: "b" }],
      },
    },
  ];
  const filled = await agent.handleGrokSessionInfo({ sessionId: created.sessionId });
  const filledContext = filled.result.context as {
    used: number;
    systemPromptTokens: number;
    messageTokens: number;
    toolDefinitionsTokens: number;
    toolDefinitionsCount: number;
  };
  expect(filledContext.used).toBeGreaterThan(context.used);
  expect(filledContext.systemPromptTokens).toBeGreaterThan(0);
  expect(filledContext.messageTokens).toBeGreaterThan(0);
  expect(filledContext.toolDefinitionsTokens).toBeGreaterThan(0);
  expect(filledContext.toolDefinitionsCount).toBe(2);

  const usage = await agent.handleGrokSessionUsage({ sessionId: created.sessionId });
  expect(usage.usage.inputTokens).toBeGreaterThan(0);
  expect(usage.usage.outputTokens).toBeGreaterThan(0);
  expect(usage.usage.costUsdTicks).toBeGreaterThan(0);
});

test("fork of an unknown session fails immediately", async () => {
  const { agent, cwd } = harness();
  live.push(agent);
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const started = Date.now();
  await expect(
    agent.unstable_forkSession({ sessionId: randomUUID(), cwd, mcpServers: [] }),
  ).rejects.toThrow(/not found/i);
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("fork spawn errors are not rewritten as resource not found", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cc-mods-acp-"));
  const updates: SessionNotification[] = [];
  const agent = new ClaudeAcpAgent(mockClient(updates), silent, {
    startEngine: (args) => {
      if (args.fork) throw new Error("herdr-backend: timed out waiting for TUI input-ready");
      const sessionId = args.sessionId ?? randomUUID();
      return { sessionId, pty: fakePty(), cwd: args.cwd };
    },
    modelCatalogSource: async () => MODEL_CATALOG,
    discoverCommands: () => [...BUILTIN_COMMANDS],
    discoverAgents: () => [],
    getSessionInfo: async () => undefined,
    listStoredSessions: async () => [],
    deleteStoredSession: async () => {},
    renameStoredSession: async () => {},
    getMessages: async () => [],
    fastModeProbe: () => false,
    getPlanUsage: async () => undefined,
  });
  live.push(agent);
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const created = await agent.newSession({ cwd, mcpServers: [] });
  await expect(agent.unstable_forkSession({ sessionId: created.sessionId, cwd, mcpServers: [] })).rejects.toThrow(
    /timed out waiting for TUI input-ready/,
  );
});

test("fork of a disk-only session still spawns --fork-session", async () => {
  const sourceId = randomUUID();
  const cwd = mkdtempSync(join(tmpdir(), "cc-mods-acp-"));
  const transcript = join(cwd, `${sourceId}.jsonl`);
  writeFileSync(transcript, "{}\n");
  const updates: SessionNotification[] = [];
  const starts: StartEngineArgs[] = [];
  const agent = new ClaudeAcpAgent(mockClient(updates), silent, {
    startEngine: (args) => {
      starts.push(args);
      const sessionId = args.sessionId ?? randomUUID();
      return { sessionId, pty: fakePty(), cwd: args.cwd };
    },
    modelCatalogSource: async () => MODEL_CATALOG,
    discoverCommands: () => [...BUILTIN_COMMANDS],
    discoverAgents: () => [],
    findTranscript: (id) => (id === sourceId ? [transcript] : []),
    getSessionInfo: async () => undefined,
    listStoredSessions: async () => [],
    deleteStoredSession: async () => {},
    renameStoredSession: async () => {},
    getMessages: async () => [],
    fastModeProbe: () => false,
    getPlanUsage: async () => undefined,
  });
  live.push(agent);
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const forked = await agent.unstable_forkSession({ sessionId: sourceId, cwd, mcpServers: [] });
  expect(forked.sessionId).not.toBe(sourceId);
  expect(starts[0]).toMatchObject({
    fork: true,
    resumeFrom: sourceId,
    sessionId: forked.sessionId,
  });
});

const HISTORY = [
  { uuid: "hist-user", type: "user", message: { role: "user", content: "old question" } },
  { uuid: "hist-asst", type: "assistant", message: { role: "assistant", content: "old answer" } },
];

test("session/load after fork replays parent history when the child transcript is still empty", async () => {
  let parentId = "";
  const { agent, cwd, updates } = harness({
    getMessages: async (sessionId) => (sessionId === parentId ? HISTORY : []),
  });
  live.push(agent);
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const created = await agent.newSession({ cwd, mcpServers: [] });
  parentId = created.sessionId;

  const forked = await agent.unstable_forkSession({
    sessionId: created.sessionId,
    cwd,
    mcpServers: [],
  });
  updates.length = 0;
  await agent.loadSession({ sessionId: forked.sessionId, cwd, mcpServers: [] });
  expect(textOf(updates)).toContain("old question");
  expect(textOf(updates)).toContain("old answer");
});

test("session/resume after fork replays inherited history on first attach", async () => {
  let parentId = "";
  const { agent, cwd, updates } = harness({
    getMessages: async (sessionId) => (sessionId === parentId ? HISTORY : []),
  });
  live.push(agent);
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const created = await agent.newSession({ cwd, mcpServers: [] });
  parentId = created.sessionId;

  const forked = await agent.unstable_forkSession({
    sessionId: created.sessionId,
    cwd,
    mcpServers: [],
  });
  updates.length = 0;
  await agent.resumeSession({ sessionId: forked.sessionId, cwd, mcpServers: [] });
  expect(textOf(updates)).toContain("old question");
  expect(textOf(updates)).toContain("old answer");
});

test("session/load after fork prefers the child transcript once it inherits parent turns", async () => {
  let parentId = "";
  let childId = "";
  let childReads = 0;
  const childHistory = [
    { uuid: "child-user", type: "user", message: { role: "user", content: "child question" } },
    { uuid: "child-asst", type: "assistant", message: { role: "assistant", content: "child answer" } },
  ];
  const { agent, cwd, updates } = harness({
    forkHistoryWaitMs: 1_000,
    getMessages: async (sessionId) => {
      if (sessionId === parentId) return HISTORY;
      if (sessionId === childId) {
        childReads += 1;
        return childReads >= 2 ? childHistory : [];
      }
      return [];
    },
  });
  live.push(agent);
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const created = await agent.newSession({ cwd, mcpServers: [] });
  parentId = created.sessionId;
  const forked = await agent.unstable_forkSession({
    sessionId: created.sessionId,
    cwd,
    mcpServers: [],
  });
  childId = forked.sessionId;
  updates.length = 0;
  await agent.loadSession({ sessionId: forked.sessionId, cwd, mcpServers: [] });
  expect(textOf(updates)).toContain("child question");
  expect(textOf(updates)).toContain("child answer");
  expect(textOf(updates)).not.toContain("old question");
});

test("close deletes an unused new session that never received a prompt", async () => {
  const { agent, cwd, deleted } = harness();
  live.push(agent);
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const created = await agent.newSession({ cwd, mcpServers: [] });
  await agent.closeSession({ sessionId: created.sessionId });
  expect(deleted).toContain(created.sessionId);
});

test("dispose deletes unused new sessions left behind on Ctrl+C", async () => {
  const { agent, cwd, deleted } = harness();
  live.push(agent);
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const created = await agent.newSession({ cwd, mcpServers: [] });
  await agent.dispose();
  expect(deleted).toContain(created.sessionId);
});

test("close keeps a new session after the user sends a prompt", async () => {
  const { agent, cwd, deleted } = harness();
  live.push(agent);
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const created = await agent.newSession({ cwd, mcpServers: [] });
  await agent.prompt(slashPrompt(created.sessionId, "/usage"));
  await agent.closeSession({ sessionId: created.sessionId });
  expect(deleted).not.toContain(created.sessionId);
});

test("close keeps forked and resumed sessions even without a new prompt", async () => {
  const { agent, cwd, deleted } = harness();
  live.push(agent);
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const created = await agent.newSession({ cwd, mcpServers: [] });
  await agent.prompt(slashPrompt(created.sessionId, "/usage"));
  const forked = await agent.unstable_forkSession({
    sessionId: created.sessionId,
    cwd,
    mcpServers: [],
  });
  await agent.closeSession({ sessionId: created.sessionId });
  await agent.closeSession({ sessionId: forked.sessionId });
  expect(deleted).not.toContain(created.sessionId);
  expect(deleted).not.toContain(forked.sessionId);

  const reopened = await agent.resumeSession({
    sessionId: created.sessionId,
    cwd,
    mcpServers: [],
  });
  await agent.closeSession({ sessionId: reopened.sessionId });
  expect(deleted).not.toContain(created.sessionId);
});

test("session/cancel settles an in-flight prompt as cancelled", async () => {
  const { agent, cwd } = harness({ immediate: true });
  live.push(agent);
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const created = await agent.newSession({ cwd, mcpServers: [] });
  const pending = agent.prompt({
    sessionId: created.sessionId,
    prompt: [{ type: "text", text: "keep going" }],
  });
  await waitForTurn(agent, created.sessionId);
  await agent.cancel({ sessionId: created.sessionId });
  expect(await pending).toEqual({ stopReason: "cancelled" });
});

test("x.ai/interject injects into the live Claude TUI turn", async () => {
  const writes: string[] = [];
  const { agent, cwd } = harness({ immediate: true, writes });
  live.push(agent);
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const created = await agent.newSession({ cwd, mcpServers: [] });
  const pending = agent.prompt({
    sessionId: created.sessionId,
    prompt: [{ type: "text", text: "first" }],
  });
  await waitForTurn(agent, created.sessionId);
  expect(parseGrokInterject({ sessionId: created.sessionId, text: "steer left" })).toEqual({
    sessionId: created.sessionId,
    text: "steer left",
    interjectionId: undefined,
    content: undefined,
  });
  const escapesBefore = writes.filter((w) => w === "\x1b").length;
  const queued = await agent.handleGrokInterject({
    sessionId: created.sessionId,
    text: "steer left",
  });
  expect(queued).toEqual({ result: { status: "queued" } });
  expect(writes.join("")).toContain("steer left");
  expect(writes.filter((w) => w === "\x1b").length).toBe(escapesBefore);
  expect(agent.sessions[created.sessionId]?.turnCancel).toBeDefined();
  await agent.cancel({ sessionId: created.sessionId });
  expect(await pending).toEqual({ stopReason: "cancelled" });
});

test("session/prompt while a turn is running waits for that turn to finish", async () => {
  const writes: string[] = [];
  const { agent, cwd } = harness({ immediate: true, writes });
  live.push(agent);
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const created = await agent.newSession({ cwd, mcpServers: [] });
  const first = agent.prompt({
    sessionId: created.sessionId,
    prompt: [{ type: "text", text: "first-turn" }],
  });
  await waitForTurn(agent, created.sessionId);
  const second = agent.prompt({
    sessionId: created.sessionId,
    prompt: [{ type: "text", text: "queued-later" }],
  });
  await flush();
  expect(writes.join("")).toContain("first-turn");
  expect(writes.join("")).not.toContain("queued-later");
  agent.sessions[created.sessionId]?.turnDetector?.finish("end_turn");
  expect(await first).toEqual({ stopReason: "end_turn" });
  await flush();
  await waitForTurn(agent, created.sessionId);
  expect(writes.join("")).toContain("queued-later");
  agent.sessions[created.sessionId]?.turnDetector?.finish("end_turn");
  expect(await second).toEqual({ stopReason: "end_turn" });
});

test("sendNow mid-turn steers without cancelling the running prompt", async () => {
  const writes: string[] = [];
  const { agent, cwd } = harness({ immediate: true, writes });
  live.push(agent);
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const created = await agent.newSession({ cwd, mcpServers: [] });
  const first = agent.prompt({
    sessionId: created.sessionId,
    prompt: [{ type: "text", text: "first-turn" }],
  });
  await waitForTurn(agent, created.sessionId);
  const escapesBefore = writes.filter((w) => w === "\x1b").length;
  const steered = await agent.prompt({
    sessionId: created.sessionId,
    prompt: [{ type: "text", text: "steer-now" }],
    _meta: { sendNow: true },
  });
  expect(steered).toEqual({ stopReason: "end_turn" });
  expect(writes.join("")).toContain("steer-now");
  expect(writes.filter((w) => w === "\x1b").length).toBe(escapesBefore);
  expect(agent.sessions[created.sessionId]?.turnCancel).toBeDefined();
  agent.sessions[created.sessionId]?.turnDetector?.finish("end_turn");
  expect(await first).toEqual({ stopReason: "end_turn" });
});

test("interject without an in-flight turn is rejected", async () => {
  const { agent, cwd } = harness({ immediate: true });
  live.push(agent);
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const created = await agent.newSession({ cwd, mcpServers: [] });
  await expect(
    agent.handleGrokInterject({ sessionId: created.sessionId, text: "later" }),
  ).rejects.toThrow(/no turn in progress/);
});

test("compact_boundary replay is a Grok compaction banner, not a user message", async () => {
  const history = [
    {
      type: "system",
      subtype: "compact_boundary",
      uuid: "boundary-1",
      compactMetadata: { trigger: "auto", preTokens: 180_000, postTokens: 12_000 },
    },
    {
      type: "user",
      uuid: "summary-1",
      isCompactSummary: true,
      message: { role: "user", content: [{ type: "text", text: "We compacted the earlier turns." }] },
    },
    {
      type: "user",
      uuid: "u1",
      message: { role: "user", content: [{ type: "text", text: "keep going" }] },
    },
    {
      type: "assistant",
      uuid: "a1",
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    },
  ];
  const { agent, cwd, updates, extNotes } = harness({
    getMessages: async () => history,
  });
  live.push(agent);
  await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: { session: { compaction: {} } },
  });
  const created = await agent.newSession({ cwd, mcpServers: [] });
  updates.length = 0;
  extNotes.length = 0;
  await agent.loadSession({ sessionId: created.sessionId, cwd, mcpServers: [] });

  expect(textOf(updates)).toContain("keep going");
  expect(textOf(updates)).toContain("ok");
  expect(textOf(updates)).not.toContain("We compacted the earlier turns.");

  const grokUpdates = extNotes
    .filter((note) => note.method === "x.ai/session_notification")
    .map((note) => (note.params as { update?: { sessionUpdate?: string } }).update?.sessionUpdate);
  expect(grokUpdates).toContain("auto_compact_completed");
  expect(extNotes.some((note) => note.method === "pi/ui/compaction_summary")).toBe(true);

  const acpCompaction = updates.filter(
    (note) => (note.update as { sessionUpdate?: string }).sessionUpdate === "compaction_update",
  );
  expect(acpCompaction.length).toBeGreaterThan(0);
  expect(
    acpCompaction.some((note) => (note.update as { status?: string }).status === "completed"),
  ).toBe(true);
});

test("Grok yoloMode / autoMode meta maps onto Claude permission modes", () => {
  expect(permissionModeFromClientMeta({ yoloMode: true, autoMode: false })).toBe("bypassPermissions");
  expect(permissionModeFromClientMeta({ yoloMode: false, autoMode: true })).toBe("auto");
  expect(permissionModeFromClientMeta({ yoloMode: false, autoMode: false })).toBe("default");
  expect(permissionModeFromClientMeta({})).toBeUndefined();
});

test("session/new follows Grok yoloMode and otherwise starts in bypass", async () => {
  const yolo = harness();
  live.push(yolo.agent);
  await yolo.agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const yoloSession = await yolo.agent.newSession({
    cwd: yolo.cwd,
    mcpServers: [],
    _meta: { yoloMode: true, autoMode: false },
  });
  expect(yolo.starts[0]?.permissionMode).toBe("bypassPermissions");
  expect(yoloSession.modes?.currentModeId).toBe("bypassPermissions");

  const auto = harness();
  live.push(auto.agent);
  await auto.agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const autoSession = await auto.agent.newSession({
    cwd: auto.cwd,
    mcpServers: [],
    _meta: { yoloMode: false, autoMode: true },
  });
  expect(auto.starts[0]?.permissionMode).toBe("auto");
  expect(autoSession.modes?.currentModeId).toBe("auto");

  const fallback = harness();
  live.push(fallback.agent);
  await fallback.agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const fallbackSession = await fallback.agent.newSession({ cwd: fallback.cwd, mcpServers: [] });
  expect(fallback.starts[0]?.permissionMode).toBe("bypassPermissions");
  expect(fallbackSession.modes?.currentModeId).toBe("bypassPermissions");
});

test("session/new applies Grok create-session _meta to spawn and ACP state", async () => {
  const preferred = "22222222-2222-4222-8222-222222222222";
  const { agent, cwd, starts } = harness({
    discoverAgents: () => [{ value: "explore", displayName: "Explore" }],
  });
  live.push(agent);
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const session = await agent.newSession({
    cwd,
    mcpServers: [],
    _meta: {
      yoloMode: true,
      autoMode: false,
      modelId: "sonnet",
      sessionId: preferred,
      askUserQuestion: false,
      agentProfile: "explore",
    },
  });
  expect(session.sessionId).toBe(preferred);
  expect(starts[0]?.sessionId).toBe(preferred);
  expect(starts[0]?.permissionMode).toBe("bypassPermissions");
  expect(starts[0]?.extraFlags?.model).toBe("sonnet");
  expect(starts[0]?.agent).toBe("explore");
  expect(starts[0]?.disallowedTools).toContain("AskUserQuestion");
  expect(session.modes?.currentModeId).toBe("bypassPermissions");
  const modelOpt = session.configOptions?.find((o) => o.id === "model");
  expect(modelOpt?.currentValue).toBe("sonnet");
});

test("session/new ignores Grok-only model and agentProfile values", async () => {
  const { agent, cwd, starts } = harness();
  live.push(agent);
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const session = await agent.newSession({
    cwd,
    mcpServers: [],
    _meta: {
      yoloMode: false,
      autoMode: false,
      modelId: "grok-4",
      sessionId: "not-a-uuid",
      agentProfile: "grok-build-plan",
    },
  });
  expect(session.sessionId).not.toBe("not-a-uuid");
  expect(starts[0]?.extraFlags?.model).toBeUndefined();
  expect(starts[0]?.agent).toBeUndefined();
  expect(starts[0]?.disallowedTools).toBeUndefined();
  expect(starts[0]?.permissionMode).toBe("default");
  const modelOpt = session.configOptions?.find((o) => o.id === "model");
  expect(modelOpt?.currentValue).toBe("default");
});

test("initialize does not advertise the relay package name", async () => {
  const { agent } = harness();
  live.push(agent);
  const init = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  expect(init.agentInfo?.name).toBe("claude");
  expect(init.agentInfo?.title).toBe("Claude");
});

test("Mods tool events hold the stall watchdog instead of letting a live turn expire", async () => {
  const { agent, cwd } = harness();
  live.push(agent);
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const created = await agent.newSession({ cwd, mcpServers: [] });
  const session = agent.sessions[created.sessionId];
  const held: string[] = [];
  const released: string[] = [];
  let notes = 0;
  session.turnDetector = {
    beginTurn() {},
    observe() {},
    noteActivity() {
      notes += 1;
    },
    hold(id) {
      held.push(id);
    },
    release(id) {
      released.push(id);
    },
    markCancelled() {},
    stop() {},
    finish() {},
  };
  await agent.handleModEvent({
    type: "tool_started",
    toolUseId: "t1",
    tool: "Read",
    input: { file_path: "/tmp/a" },
  });
  expect(held).toEqual(["t1"]);
  await agent.handleModEvent({
    type: "tool_finished",
    toolUseId: "t1",
    tool: "Read",
    result: "ok",
  });
  expect(released).toEqual(["t1"]);
  await agent.handleModEvent({ type: "chunk", text: "hello", kind: "assistant" });
  expect(notes).toBeGreaterThan(0);
});

