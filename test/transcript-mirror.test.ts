import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.js";
import {
  applyTranscriptChunk,
  encodeProjectDir,
  isSafeTranscriptRel,
  loadTranscriptCursors,
  sessionIdFromRel,
  TRANSCRIPT_SIDECAR_SUFFIX,
} from "../src/transcript-mirror.js";
import { backfillTranscripts, rsyncBackfillArgv } from "../src/transcript-backfill.js";
import { listProjectJsonl, startTranscriptSync, type TranscriptAppendFrame } from "../src/transcript-sync.js";

function openWs(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("socket failed"));
  });
}

function inbox(ws: WebSocket) {
  const msgs: Record<string, unknown>[] = [];
  const waiters: Array<(msg: Record<string, unknown>) => void> = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
    const next = waiters.shift();
    if (next) next(msg);
    else msgs.push(msg);
  });
  return {
    next(timeoutMs = 5_000): Promise<Record<string, unknown>> {
      if (msgs.length) return Promise.resolve(msgs.shift()!);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("socket timed out")), timeoutMs);
        waiters.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    },
  };
}

test("encodeProjectDir matches Claude Code's projects folder name", () => {
  expect(encodeProjectDir("/Users/alice/.cursor/worktrees/wt/app")).toBe(
    "-Users-alice--cursor-worktrees-wt-app",
  );
  expect(encodeProjectDir("/Users/alice/my_proj")).toBe("-Users-alice-my-proj");
  expect(isSafeTranscriptRel("-Users-alice-app/s.jsonl")).toBe(true);
  expect(isSafeTranscriptRel("../etc/passwd.jsonl")).toBe(false);
  expect(isSafeTranscriptRel("/abs.jsonl")).toBe(false);
  expect(sessionIdFromRel("-Users-alice-app/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl")).toBe(
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  );
});

test("applyTranscriptChunk writes jsonl, sidecar, and cursor", () => {
  const root = mkdtempSync(join(tmpdir(), "cc-mods-mirror-"));
  const cfg = mkdtempSync(join(tmpdir(), "cc-mods-cfg-"));
  const rel = "-Users-alice-app/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl";
  try {
    const first = applyTranscriptChunk(root, rel, 0, Buffer.from("abc"), {
      via: "ws",
      now: () => "2026-11-16T15:29:15Z",
      configDir: cfg,
    });
    expect(first?.size).toBe(3);
    expect(readFileSync(first!.path, "utf8")).toBe("abc");
    const more = applyTranscriptChunk(root, rel, 3, Buffer.from("de"), { configDir: cfg });
    expect(more?.size).toBe(5);
    expect(readFileSync(more!.path, "utf8")).toBe("abcde");
    const sidecar = JSON.parse(readFileSync(more!.path + TRANSCRIPT_SIDECAR_SUFFIX, "utf8"));
    expect(sidecar).toEqual({
      sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      size: 5,
      mirroredAt: expect.any(String),
      via: "ws",
    });
    expect(loadTranscriptCursors(cfg)["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]).toEqual({
      rel,
      offset: 5,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  }
});

test("applyTranscriptChunk skips a gap past EOF", () => {
  const root = mkdtempSync(join(tmpdir(), "cc-mods-mirror-gap-"));
  const cfg = mkdtempSync(join(tmpdir(), "cc-mods-cfg-"));
  const rel = "-Users-alice-app/cccccccccccccccccccccccccccccccc.jsonl";
  try {
    applyTranscriptChunk(root, rel, 0, Buffer.from("abc"), { configDir: cfg });
    expect(applyTranscriptChunk(root, rel, 10, Buffer.from("x"), { configDir: cfg })).toBeUndefined();
    expect(readFileSync(join(root, rel), "utf8")).toBe("abc");
    expect(loadTranscriptCursors(cfg)["cccccccccccccccccccccccccccccccc"]?.offset).toBe(3);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  }
});

test("applyTranscriptChunk offset 0 replaces the file", () => {
  const root = mkdtempSync(join(tmpdir(), "cc-mods-mirror-z-"));
  const cfg = mkdtempSync(join(tmpdir(), "cc-mods-cfg-"));
  const rel = "-Users-alice-app/cccccccccccccccccccccccccccccccc.jsonl";
  try {
    applyTranscriptChunk(root, rel, 0, Buffer.from("old-content"), { configDir: cfg });
    applyTranscriptChunk(root, rel, 0, Buffer.from("new"), { configDir: cfg });
    expect(readFileSync(join(root, rel), "utf8")).toBe("new");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  }
});

test("listProjectJsonl walks a Claude projects folder and skips sidecars", () => {
  const projects = mkdtempSync(join(tmpdir(), "cc-mods-projects-"));
  const folder = "-Users-alice-app";
  mkdirSync(join(projects, folder, "sid"), { recursive: true });
  writeFileSync(join(projects, folder, "aaaa.jsonl"), "a\n");
  writeFileSync(join(projects, folder, "aaaa.jsonl" + TRANSCRIPT_SIDECAR_SUFFIX), "{}\n");
  writeFileSync(join(projects, folder, "sid", "bbbb.jsonl"), "b\n");
  mkdirSync(join(projects, "other"), { recursive: true });
  writeFileSync(join(projects, "other", "skip.jsonl"), "nope\n");
  try {
    expect(listProjectJsonl(projects, [folder])).toEqual([
      "-Users-alice-app/aaaa.jsonl",
      "-Users-alice-app/sid/bbbb.jsonl",
    ]);
  } finally {
    rmSync(projects, { recursive: true, force: true });
  }
});

test("startTranscriptSync sends existing bytes then growth on flush", () => {
  const claude = mkdtempSync(join(tmpdir(), "cc-mods-claude-"));
  const folder = encodeProjectDir("/Users/alice/app");
  const rel = `${folder}/dddddddd-dddd-4ddd-8ddd-dddddddddddd.jsonl`;
  mkdirSync(join(claude, "projects", folder), { recursive: true });
  const path = join(claude, "projects", rel);
  writeFileSync(path, "one\n");
  const frames: TranscriptAppendFrame[] = [];
  const sync = startTranscriptSync({
    claudeConfigDir: claude,
    send: (msg) => frames.push(msg),
    pollMs: 0,
    idleMs: 0,
    watch: false,
    chunkBytes: 8,
  });
  try {
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]?.rel).toBe(rel);
    expect(Buffer.from(frames[0]!.data, "base64").toString()).toBe("one\n");
    const before = frames.length;
    writeFileSync(path, "one\ntwo\n");
    sync.flush();
    expect(frames.length).toBeGreaterThan(before);
    expect(Buffer.from(frames.at(-1)!.data, "base64").toString()).toContain("two");
  } finally {
    sync.stop();
    rmSync(claude, { recursive: true, force: true });
  }
});

test("turn.complete flushes immediately and again after idle", async () => {
  const claude = mkdtempSync(join(tmpdir(), "cc-mods-claude-idle-"));
  const folder = encodeProjectDir("/Users/alice/app");
  const rel = `${folder}/ffffffff-ffff-4fff-8fff-ffffffffffff.jsonl`;
  mkdirSync(join(claude, "projects", folder), { recursive: true });
  const path = join(claude, "projects", rel);
  writeFileSync(path, "a\n");
  const frames: TranscriptAppendFrame[] = [];
  const sync = startTranscriptSync({
    claudeConfigDir: claude,
    send: (msg) => frames.push(msg),
    watch: false,
    idleMs: 40,
  });
  try {
    const afterStart = frames.length;
    writeFileSync(path, "a\nb\n");
    sync.onTurnComplete();
    expect(frames.length).toBeGreaterThan(afterStart);
    const afterTurn = frames.length;
    writeFileSync(path, "a\nb\nc\n");
    const deadline = Date.now() + 1_000;
    while (frames.length === afterTurn && Date.now() < deadline) await Bun.sleep(10);
    expect(frames.length).toBeGreaterThan(afterTurn);
  } finally {
    sync.stop();
    rmSync(claude, { recursive: true, force: true });
  }
});

test("turn.start flushes late bytes instead of cancelling the idle tail", () => {
  const claude = mkdtempSync(join(tmpdir(), "cc-mods-claude-start-"));
  const folder = encodeProjectDir("/Users/alice/app");
  const rel = `${folder}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl`;
  mkdirSync(join(claude, "projects", folder), { recursive: true });
  const path = join(claude, "projects", rel);
  writeFileSync(path, "a\n");
  const frames: TranscriptAppendFrame[] = [];
  const sync = startTranscriptSync({
    claudeConfigDir: claude,
    send: (msg) => frames.push(msg),
    watch: false,
    idleMs: 0,
  });
  try {
    const afterStart = frames.length;
    writeFileSync(path, "a\nb\n");
    sync.onTurnStart();
    expect(frames.length).toBeGreaterThan(afterStart);
  } finally {
    sync.stop();
    rmSync(claude, { recursive: true, force: true });
  }
});

test("flush with client cursors resends dropped bytes", () => {
  const claude = mkdtempSync(join(tmpdir(), "cc-mods-claude-rewind-"));
  const folder = encodeProjectDir("/Users/alice/app");
  const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const rel = `${folder}/${sessionId}.jsonl`;
  mkdirSync(join(claude, "projects", folder), { recursive: true });
  const path = join(claude, "projects", rel);
  writeFileSync(path, "one\ntwo\n");
  const frames: TranscriptAppendFrame[] = [];
  const sync = startTranscriptSync({
    claudeConfigDir: claude,
    send: (msg) => frames.push(msg),
    watch: false,
    idleMs: 0,
  });
  try {
    expect(frames.length).toBeGreaterThan(0);
    const before = frames.length;
    sync.flush();
    expect(frames.length).toBe(before);
    sync.flush({ [sessionId]: { rel, offset: 4 } });
    expect(frames.length).toBeGreaterThan(before);
    expect(frames.at(-1)?.offset).toBe(4);
    expect(Buffer.from(frames.at(-1)!.data, "base64").toString()).toBe("two\n");
  } finally {
    sync.stop();
    rmSync(claude, { recursive: true, force: true });
  }
});

test("rsync backfill stamps sidecars and cursors", async () => {
  const dest = mkdtempSync(join(tmpdir(), "cc-mods-rsync-dest-"));
  const cfg = mkdtempSync(join(tmpdir(), "cc-mods-rsync-cfg-"));
  const folder = "-Users-alice-app";
  mkdirSync(join(dest, folder), { recursive: true });
  const rel = `${folder}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl`;
  const argv = rsyncBackfillArgv("tui-host", dest);
  expect(argv[0]).toBe("rsync");
  expect(argv).toContain("--include=*.jsonl");
  expect(argv.at(-2)).toBe("tui-host:.claude/projects/");
  writeFileSync(join(dest, rel), '{"cwd":"/Users/alice/app"}\n');
  const result = await backfillTranscripts({
    host: "tui-host",
    dest,
    configDir: cfg,
    now: () => "2026-11-16T15:29:15Z",
    run: async () => ({ code: 0, stderr: "" }),
  });
  try {
    expect(result.files).toBe(1);
    const sidecar = JSON.parse(readFileSync(join(dest, rel) + TRANSCRIPT_SIDECAR_SUFFIX, "utf8"));
    expect(sidecar.via).toBe("rsync-backfill");
    expect(sidecar.mirroredAt).toBe("2026-11-16T15:29:15Z");
    expect(result.cursors["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]?.offset).toBe(
      '{"cwd":"/Users/alice/app"}\n'.length,
    );
  } finally {
    rmSync(dest, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  }
});

test("rsync backfill retries once then throws", async () => {
  const dest = mkdtempSync(join(tmpdir(), "cc-mods-rsync-fail-"));
  let n = 0;
  try {
    await expect(
      backfillTranscripts({
        host: "tui-host",
        dest,
        retryDelayMs: 0,
        run: async () => {
          n += 1;
          return { code: 1, stderr: "denied" };
        },
      }),
    ).rejects.toThrow(/rsync transcript backfill failed \(1\): denied/);
    expect(n).toBe(2);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test("rsync backfill succeeds on the retry", async () => {
  const dest = mkdtempSync(join(tmpdir(), "cc-mods-rsync-retry-"));
  const cfg = mkdtempSync(join(tmpdir(), "cc-mods-rsync-cfg-"));
  const folder = "-Users-alice-app";
  mkdirSync(join(dest, folder), { recursive: true });
  const rel = `${folder}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl`;
  writeFileSync(join(dest, rel), '{"cwd":"/Users/alice/app"}\n');
  let n = 0;
  try {
    const result = await backfillTranscripts({
      host: "tui-host",
      dest,
      configDir: cfg,
      retryDelayMs: 0,
      run: async () => {
        n += 1;
        if (n === 1) return { code: 1, stderr: "busy" };
        return { code: 0, stderr: "" };
      },
    });
    expect(n).toBe(2);
    expect(result.files).toBe(1);
  } finally {
    rmSync(dest, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  }
});

test("instance.start mirrors host jsonl onto the client over the session socket", async () => {
  const claude = mkdtempSync(join(tmpdir(), "cc-mods-srv-claude-"));
  const clientProjects = mkdtempSync(join(tmpdir(), "cc-mods-cli-proj-"));
  const cfg = mkdtempSync(join(tmpdir(), "cc-mods-cli-cfg-"));
  const cwd = mkdtempSync(join(tmpdir(), "cc-mods-proj-"));
  const sessionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const folder = encodeProjectDir(cwd);
  mkdirSync(join(claude, "projects", folder), { recursive: true });
  writeFileSync(join(claude, "projects", folder, `${sessionId}.jsonl`), '{"cwd":"/Users/alice/app"}\n');
  const server = startServer({
    token: "secret",
    hostname: "127.0.0.1",
    port: 0,
    boot: false,
    claudeConfigDir: claude,
    idleMs: 0,
  });
  try {
    const ws = await openWs(server.sessionUrl);
    const messages = inbox(ws);
    ws.send(JSON.stringify({ v: 1, type: "hello", token: "secret" }));
    expect((await messages.next()).ok).toBe(true);
    ws.send(JSON.stringify({ v: 1, type: "instance.start", cwd }));
    const ready = await messages.next();
    expect(ready.type).toBe("instance.ready");
    const append = await messages.next();
    expect(append.type).toBe("transcript.append");
    expect(append.rel).toBe(`${folder}/${sessionId}.jsonl`);
    writeFileSync(join(claude, "projects", folder, `${sessionId}.jsonl`), '{"cwd":"/Users/alice/app"}\n{"type":"assistant"}\n');
    ws.send(JSON.stringify({ v: 1, type: "transcript.flush" }));
    const more = await messages.next();
    expect(more.type).toBe("transcript.append");
    expect(Number(more.offset)).toBeGreaterThan(0);
    ws.send(
      JSON.stringify({
        v: 1,
        type: "transcript.flush",
        transcriptCursors: { [sessionId]: { rel: `${folder}/${sessionId}.jsonl`, offset: 0 } },
      }),
    );
    const resent = await messages.next();
    expect(resent.type).toBe("transcript.append");
    expect(Number(resent.offset)).toBe(0);
    const applied = applyTranscriptChunk(
      clientProjects,
      String(append.rel),
      Number(append.offset),
      Buffer.from(String(append.data), "base64"),
      { configDir: cfg },
    );
    applyTranscriptChunk(
      clientProjects,
      String(more.rel),
      Number(more.offset),
      Buffer.from(String(more.data), "base64"),
      { configDir: cfg },
    );
    expect(readFileSync(applied!.path, "utf8")).toContain('{"type":"assistant"}');
    const inst = [...server.instances.values()][0]!;
    const plugin = await openWs(server.toolsUrl);
    const phello = inbox(plugin);
    plugin.send(JSON.stringify({ v: 1, type: "hello", token: inst.pluginToken }));
    expect((await phello.next()).ok).toBe(true);
    writeFileSync(join(claude, "projects", folder, `${sessionId}.jsonl`), '{"cwd":"/Users/alice/app"}\n{"type":"assistant"}\n{"type":"result"}\n');
    plugin.send(JSON.stringify({ v: 1, type: "turn.complete" }));
    const afterTurn = [await messages.next(), await messages.next()];
    expect(afterTurn.map((row) => row.type)).toContain("turn.complete");
    expect(afterTurn.map((row) => row.type)).toContain("transcript.append");
    plugin.close();
    ws.close();
  } finally {
    await server.stop();
    rmSync(claude, { recursive: true, force: true });
    rmSync(clientProjects, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
