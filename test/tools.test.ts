import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { cancelCall, execute } from "../src/exec.js";
import { applyModEvent } from "../src/mod-live.js";
import { mapPath, rewriteRemoteText } from "../src/tools/paths.js";
import { nativeToolResult } from "../src/tools/runtime.js";

function run(
  dir: string,
  tool: string,
  input: Record<string, unknown>,
  opts: { callId?: string; sessionId?: string; tuiRoot?: string } = {},
) {
  return new Promise<any>((resolve) => {
    void execute(
      {
        tool,
        input,
        cwd: dir,
        tuiRoot: opts.tuiRoot ?? dir,
        callId: opts.callId ?? "t",
        sessionId: opts.sessionId,
      },
      (frame) => resolve(frame),
    );
  });
}

test("nativeToolResult wraps a string so Mods sees an object", () => {
  const read = nativeToolResult("Read", "hello\nworld", { file_path: "/tmp/a.txt" });
  expect(Array.isArray(read)).toBe(false);
  expect(read.type).toBe("text");
  expect((read.file as { content: string }).content).toBe("hello\nworld");
  const write = nativeToolResult("Write", "body", { file_path: "/tmp/a.txt" });
  expect(write.type).toBe("create");
  const obj = { type: "text", file: { content: "keep" } };
  expect(nativeToolResult("Read", obj)).toBe(obj);
});

test("nativeToolResult fallbacks match Claude Agent SDK per-tool objects", () => {
  const glob = nativeToolResult("Glob", "oops");
  expect(glob).toEqual({ durationMs: 0, numFiles: 0, filenames: [], truncated: false });
  const grep = nativeToolResult("Grep", "oops");
  expect(grep).toEqual({ numFiles: 0, filenames: [] });
  expect("mode" in glob).toBe(false);
  expect("durationMs" in grep).toBe(false);
  const notebook = nativeToolResult("NotebookEdit", "print(1)", { notebook_path: "/tmp/n.ipynb" });
  expect(notebook).toMatchObject({
    new_source: "print(1)",
    cell_type: "code",
    notebook_path: "/tmp/n.ipynb",
    original_file: "",
    updated_file: "",
  });
  const monitor = nativeToolResult("Monitor", "oops");
  expect(monitor).toEqual({ taskId: "", timeoutMs: 0 });
  const enter = nativeToolResult("EnterWorktree", "oops");
  expect(enter).toMatchObject({ worktreePath: "", message: "oops" });
  const exit = nativeToolResult("ExitWorktree", "oops");
  expect(exit).toMatchObject({ action: "keep", originalCwd: "", worktreePath: "", message: "oops" });
  expect(nativeToolResult("Bash", "hi")).toEqual({ stdout: "hi", stderr: "", interrupted: false });
  expect("value" in nativeToolResult("Unknown", "x")).toBe(false);
});

test("workspace tools return Claude Agent SDK required fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-sdk-"));
  writeFileSync(join(dir, "a.ts"), "hello\n");
  writeFileSync(
    join(dir, "n.ipynb"),
    JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      cells: [{ id: "c1", cell_type: "code", source: ["print(1)\n"], metadata: {}, outputs: [], execution_count: null }],
    }),
  );

  const read = await run(dir, "Read", { file_path: join(dir, "a.ts") });
  expect(read.ok).toBe(true);
  expect(read.result).toEqual(expect.objectContaining({
    type: "text",
    file: expect.objectContaining({
      filePath: expect.any(String),
      content: expect.any(String),
      numLines: expect.any(Number),
      startLine: expect.any(Number),
      totalLines: expect.any(Number),
    }),
  }));

  const wrote = await run(dir, "Write", { file_path: join(dir, "b.ts"), content: "x\n" });
  expect(wrote.result).toEqual(expect.objectContaining({
    type: "create",
    filePath: expect.any(String),
    content: "x\n",
    structuredPatch: expect.any(Array),
    originalFile: null,
  }));

  const edited = await run(dir, "Edit", { file_path: join(dir, "b.ts"), old_string: "x", new_string: "y" });
  expect(edited.result).toEqual(expect.objectContaining({
    filePath: expect.any(String),
    oldString: "x",
    newString: "y",
    originalFile: "x\n",
    structuredPatch: expect.any(Array),
    userModified: false,
    replaceAll: false,
  }));

  const glob = await run(dir, "Glob", { pattern: "*.ts" });
  expect(glob.result).toEqual(expect.objectContaining({
    durationMs: expect.any(Number),
    numFiles: expect.any(Number),
    filenames: expect.any(Array),
    truncated: false,
  }));

  const grep = await run(dir, "Grep", { pattern: "hello" });
  expect(grep.ok).toBe(true);
  expect(typeof grep.result.numFiles).toBe("number");
  expect(Array.isArray(grep.result.filenames)).toBe(true);

  const bash = await run(dir, "Bash", { command: "printf hi" });
  expect(bash.result).toEqual(expect.objectContaining({
    stdout: expect.any(String),
    stderr: expect.any(String),
    interrupted: false,
  }));

  const nb = await run(dir, "NotebookEdit", {
    notebook_path: join(dir, "n.ipynb"),
    cell_id: "c1",
    new_source: "print(2)",
    edit_mode: "replace",
  });
  expect(nb.ok).toBe(true);
  expect(nb.result).toEqual(expect.objectContaining({
    new_source: "print(2)",
    cell_type: "code",
    language: expect.any(String),
    edit_mode: "replace",
    notebook_path: expect.any(String),
    original_file: expect.any(String),
    updated_file: expect.any(String),
  }));

  const mon = await run(dir, "Monitor", { command: "true", timeout_ms: 5_000 }, { callId: "sdk-mon" });
  expect(mon.result).toEqual(expect.objectContaining({
    taskId: expect.any(String),
    timeoutMs: 5_000,
  }));
  cancelCall("sdk-mon");
});

test("Read honors offset/limit, rejects directories, and returns native text schema", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
  mkdirSync(join(dir, "sub"));
  const page = await run(dir, "Read", { file_path: join(dir, "a.txt"), offset: 2, limit: 1 });
  expect(page.ok).toBe(true);
  expect(page.result.type).toBe("text");
  expect(page.result.file.content).toBe("two");
  expect(page.result.file.startLine).toBe(2);
  expect(page.result.file.totalLines).toBe(3);
  const missing = await run(dir, "Read", { file_path: join(dir, "nope.txt") });
  expect(missing.ok).toBe(false);
  expect(missing.error.code).toBe("TOOL_FAILED");
  const dirRead = await run(dir, "Read", { file_path: join(dir, "sub") });
  expect(dirRead.ok).toBe(false);
});

test("Edit replace_all, unique-match failure, and empty old_string create", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  writeFileSync(join(dir, "a.ts"), "foo foo\n");
  const dup = await run(dir, "Edit", { file_path: join(dir, "a.ts"), old_string: "foo", new_string: "bar" });
  expect(dup.ok).toBe(false);
  const all = await run(dir, "Edit", { file_path: join(dir, "a.ts"), old_string: "foo", new_string: "bar", replace_all: true });
  expect(all.ok).toBe(true);
  expect(all.result.replaceAll).toBe(true);
  expect(await Bun.file(join(dir, "a.ts")).text()).toBe("bar bar\n");
  const created = await run(dir, "Edit", { file_path: join(dir, "new.ts"), old_string: "", new_string: "hi" });
  expect(created.ok).toBe(true);
  expect(created.result.originalFile).toBeNull();
});

test("Grep default is files_with_matches; content/count/glob/head_limit work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  writeFileSync(join(dir, "a.ts"), "alpha\n");
  writeFileSync(join(dir, "b.js"), "alpha\nalpha\n");
  const files = await run(dir, "Grep", { pattern: "alpha" });
  expect(files.ok).toBe(true);
  expect(files.result.mode).toBe("files_with_matches");
  expect(files.result.numFiles).toBe(2);
  const content = await run(dir, "Grep", { pattern: "alpha", output_mode: "content", glob: "*.ts" });
  expect(content.result.mode).toBe("content");
  expect(content.result.filenames.every((f: string) => f.endsWith(".ts"))).toBe(true);
  const count = await run(dir, "Grep", { pattern: "alpha", output_mode: "count", path: dir });
  expect(count.result.mode).toBe("count");
  const limited = await run(dir, "Grep", { pattern: "alpha", output_mode: "content", head_limit: 1 });
  expect(limited.result.numLines).toBe(1);
  expect(limited.result.appliedLimit).toBe(1);
});

test("Glob uses path, skips node_modules, truncates at 100", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "a");
  writeFileSync(join(dir, "node_modules", "x", "a.ts"), "n");
  const found = await run(dir, "Glob", { pattern: "**/*.ts", path: dir });
  expect(found.ok).toBe(true);
  expect(found.result.filenames.some((f: string) => f.includes("src/a.ts") || f.endsWith("src/a.ts"))).toBe(true);
  expect(found.result.filenames.some((f: string) => f.includes("node_modules"))).toBe(false);
});

test("relative TUI paths map onto the client workspace", () => {
  const cwd = "/Users/me/proj";
  const tui = "/Users/bob/Workspace/abc";
  const home = homedir();
  expect(mapPath(cwd, tui, "src/a.ts")).toBe("/Users/me/proj/src/a.ts");
  expect(mapPath(cwd, tui, "/Users/bob/Workspace/abc/src/a.ts")).toBe("/Users/me/proj/src/a.ts");
  expect(mapPath(cwd, tui, "/Users/me/other/x.ts", ["/Users/me/other"])).toBe("/Users/me/other/x.ts");
  expect(mapPath(cwd, tui, "/Users/bob/.cursor/artifacts/x.sh")).toBe(join(home, ".cursor/artifacts/x.sh"));
  expect(mapPath(cwd, tui, join(home, ".cursor/artifacts/x.sh"))).toBe(join(home, ".cursor/artifacts/x.sh"));
  expect(() => mapPath(cwd, tui, "/Users/bob/Workspace/other/x.ts")).toThrow(/outside/);
  expect(rewriteRemoteText("cd /Users/bob/Workspace/abc && ls", cwd, tui)).toBe("cd /Users/me/proj && ls");
  expect(rewriteRemoteText("cd /Users/bob/Workspace/abc-extra", cwd, tui)).toBe(`cd ${home}/Workspace/abc-extra`);
  expect(rewriteRemoteText("cd ~/Workspace/abc && pwd", cwd, tui)).toBe("cd /Users/me/proj && pwd");
  expect(rewriteRemoteText("cat ~/.cursor/artifacts/x.sh", cwd, tui)).toBe(`cat ${home}/.cursor/artifacts/x.sh`);
});

test("Bash returns stdout/stderr/interrupted; non-zero is still a result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  const ok = await run(dir, "Bash", { command: "echo hi" });
  expect(ok.ok).toBe(true);
  expect(ok.result.stdout).toContain("hi");
  expect(ok.result.interrupted).toBe(false);
  const fail = await run(dir, "Bash", { command: "exit 7" });
  expect(fail.ok).toBe(true);
  expect(fail.result.stderr).toContain("Exit code 7");
});

test("Read returns native image schema and ACP image content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  writeFileSync(join(dir, "dot.png"), png);
  const img = await run(dir, "Read", { file_path: join(dir, "dot.png") });
  expect(img.ok).toBe(true);
  expect(img.result.type).toBe("image");
  expect(img.result.file.type).toBe("image/png");
  expect(img.result.file.originalSize).toBe(png.byteLength);
  expect(img.result.file.dimensions).toMatchObject({ originalWidth: 1, originalHeight: 1, displayWidth: 1, displayHeight: 1 });

  const notes: any[] = [];
  const client = { sessionUpdate: async (note: any) => { notes.push(note.update); } };
  const tools = new Map<string, { tool: string; input: Record<string, unknown> }>();
  await applyModEvent("s", { type: "tool_started", toolUseId: "img1", tool: "Read", input: { file_path: join(dir, "dot.png") } }, {
    client, tools, cwd: dir, supportsTerminal: false,
  });
  await applyModEvent("s", { type: "tool_finished", toolUseId: "img1", isError: false, result: img.result }, {
    client, tools, cwd: dir, supportsTerminal: false,
  });
  const done = notes.find((u) => u.sessionUpdate === "tool_call_update" && u.status === "completed");
  expect(done.content[0].content.type).toBe("image");
  expect(done.content[0].content.mimeType).toBe("image/png");
  expect(done.content[0].content.data).toBe(img.result.file.base64);
});

test("Read compresses large images to JPEG 85 within the API long-edge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  const seed = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const bulky = Buffer.from(await new Bun.Image(seed).resize(2000, 1500).jpeg({ quality: 100 }).bytes());
  writeFileSync(join(dir, "wide.jpg"), bulky);
  const img = await run(dir, "Read", { file_path: join(dir, "wide.jpg") });
  expect(img.ok).toBe(true);
  expect(img.result.file.type).toBe("image/jpeg");
  expect(img.result.file.originalSize).toBe(bulky.byteLength);
  expect(Buffer.from(img.result.file.base64, "base64").byteLength).toBeLessThan(bulky.byteLength);
  expect(img.result.file.dimensions.originalWidth).toBe(2000);
  expect(img.result.file.dimensions.originalHeight).toBe(1500);
  expect(img.result.file.dimensions.displayWidth).toBeLessThanOrEqual(1568);
  expect(img.result.file.dimensions.displayHeight).toBeLessThanOrEqual(1568);
});

test("Read rejects binary files that are not images", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 0, 3, 4]));
  const bad = await run(dir, "Read", { file_path: join(dir, "blob.bin") });
  expect(bad.ok).toBe(false);
  expect(bad.error.message).toMatch(/binary/i);
});

test("Bash cancel during run returns interrupted without waiting out the command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  const started = Date.now();
  const pending = new Promise<any>((resolve) => {
    void execute({ tool: "Bash", input: { command: "sleep 30" }, cwd: dir, tuiRoot: dir, callId: "sleep-1" }, (frame) => resolve(frame));
  });
  await Bun.sleep(80);
  cancelCall("sleep-1");
  const frame = await pending;
  expect(frame.ok).toBe(true);
  expect(frame.result.interrupted).toBe(true);
  expect(frame.result.stderr).toMatch(/aborted/i);
  expect(Date.now() - started).toBeLessThan(5_000);
});

test("Write to ~/.cursor/artifacts is allowed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  const dest = join(homedir(), ".cursor", "artifacts", "cc-mods-relay-test", "out.txt");
  try {
    const wrote = await run(dir, "Write", { file_path: dest, content: "scratch\n" }, { callId: "art" });
    expect(wrote.ok).toBe(true);
    expect(await Bun.file(dest).text()).toBe("scratch\n");
  } finally {
    rmSync(join(homedir(), ".cursor", "artifacts", "cc-mods-relay-test"), { recursive: true, force: true });
  }
});

test("Bash rewrites Mini TUI paths onto the client workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  const tui = "/Users/bob/Workspace/abc";
  const frame = await run(dir, "Bash", { command: `test -d '${tui}' && printf mapped` }, { tuiRoot: tui, callId: "rw", sessionId: "rw" });
  expect(frame.ok).toBe(true);
  expect(frame.result.stdout).toContain("mapped");
  const home = await run(dir, "Bash", { command: `printf '%s' "$HOME"` }, { tuiRoot: tui, callId: "rw-home", sessionId: "rw" });
  expect(home.result.stdout).toBe(homedir());
});

test("session cwd after cd applies to later Read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "a.txt"), "root\n");
  writeFileSync(join(dir, "sub", "a.txt"), "nested\n");
  const cd = await run(dir, "Bash", { command: "cd sub" }, { callId: "cd1", sessionId: "cwd-sess" });
  expect(cd.ok).toBe(true);
  const read = await run(dir, "Read", { file_path: "a.txt" }, { callId: "cd2", sessionId: "cwd-sess" });
  expect(read.ok).toBe(true);
  expect(read.result.file.content).toBe("nested");
});

test("Monitor starts in the background and streams stdout lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  const frames: any[] = [];
  const started = Date.now();
  const frame = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Monitor did not return")), 5_000);
    void execute(
      {
        tool: "Monitor",
        input: { command: "printf 'watched\\n'", timeout_ms: 8_000, description: "watch" },
        cwd: dir,
        tuiRoot: dir,
        callId: "mon",
      },
      (next) => {
        frames.push(next);
        if (next.type === "result") {
          clearTimeout(timer);
          resolve(next);
        }
      },
      (next) => {
        frames.push(next);
      },
    );
  });
  expect(Date.now() - started).toBeLessThan(3_000);
  expect(frame.ok).toBe(true);
  expect(frame.result.taskId).toBeDefined();
  expect(frame.result.timeoutMs).toBe(8_000);
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && !frames.some((f) => f.kind === "monitor" && String(f.line || "").includes("watched"))) {
    await Bun.sleep(20);
  }
  expect(frames.some((f) => f.kind === "monitor" && String(f.line || "").includes("watched"))).toBe(true);
});

test("Monitor does not block on a long command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  const started = Date.now();
  const frame = await run(dir, "Monitor", { command: "sleep 30", timeout_ms: 60_000, description: "wait" }, { callId: "mon-nb" });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(frame.ok).toBe(true);
  expect(frame.result.taskId).toBeDefined();
  expect(frame.result.timeoutMs).toBe(60_000);
  cancelCall("mon-nb");
});

test("Bash foreground timeout auto-backgrounds instead of killing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "a.txt"), "root\n");
  writeFileSync(join(dir, "sub", "a.txt"), "nested\n");
  const frames: any[] = [];
  const started = Date.now();
  const frame = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Bash did not return")), 6_000);
    void execute(
      {
        tool: "Bash",
        input: { command: "cd sub; printf start\\n; sleep 3.2; printf done\\n", timeout: 120 },
        cwd: dir,
        tuiRoot: dir,
        callId: "bg-timeout",
        sessionId: "bg-timeout-sess",
      },
      (next) => {
        frames.push(next);
        if (next.type === "result") {
          clearTimeout(timer);
          resolve(next);
        }
      },
      (next) => {
        frames.push(next);
      },
    );
  });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(frame.ok).toBe(true);
  expect(frame.result.interrupted).toBe(false);
  expect(frame.result.backgroundTaskId).toBeDefined();
  expect(frame.result.timedOutAfterMs).toBe(120);
  expect(frame.result.backgroundCwdHint).toMatch(/Session cwd remains/);
  expect(String(frame.result.stdout)).not.toContain("done");
  const later = await run(dir, "Read", { file_path: "a.txt" }, { callId: "bg-timeout-read", sessionId: "bg-timeout-sess" });
  expect(later.result.file.content).toBe("root");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !frames.some((f) => f.kind === "background" && String(f.output || "").includes("done"))) {
    await Bun.sleep(20);
  }
  expect(frames.some((f) => f.kind === "background" && String(f.output || "").includes("done"))).toBe(true);
});

test("EnterWorktree path switches session cwd; ExitWorktree keep restores", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  writeFileSync(join(dir, "here.txt"), "root\n");
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  git(["init"]);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"]);
  const wt = join(dir, "wt");
  git(["worktree", "add", "--detach", wt]);
  writeFileSync(join(wt, "here.txt"), "tree\n");
  const entered = await run(dir, "EnterWorktree", { path: wt }, { callId: "ew", sessionId: "wt-sess" });
  expect(entered.ok).toBe(true);
  expect(entered.result.worktreePath).toBe(realpathSync(wt));
  const nested = await run(dir, "Read", { file_path: "here.txt" }, { callId: "ew-r", sessionId: "wt-sess" });
  expect(nested.result.file.content).toBe("tree");
  const missing = await run(dir, "ExitWorktree", {}, { callId: "ex-bad", sessionId: "wt-sess" });
  expect(missing.ok).toBe(false);
  const exited = await run(dir, "ExitWorktree", { action: "keep" }, { callId: "ex", sessionId: "wt-sess" });
  expect(exited.ok).toBe(true);
  expect(exited.result.action).toBe("keep");
  const root = await run(dir, "Read", { file_path: "here.txt" }, { callId: "ex-r", sessionId: "wt-sess" });
  expect(root.result.file.content).toBe("root");
});

test("mod events become ACP session updates", async () => {
  const updates: any[] = [];
  const client = { sessionUpdate: async (note: any) => { updates.push(note.update); } };
  const tools = new Map<string, { tool: string; input: Record<string, unknown> }>();
  expect(await applyModEvent("s", { type: "chunk", kind: "text", text: "hi" }, {
    client, tools, cwd: "/tmp", supportsTerminal: false,
  })).toBeUndefined();
  expect(updates[0].sessionUpdate).toBe("agent_message_chunk");
  expect(await applyModEvent("s", { type: "tool_started", toolUseId: "1", tool: "Read", input: { file_path: "/tmp/a" } }, {
    client, tools, cwd: "/tmp", supportsTerminal: false,
  })).toBeUndefined();
  expect(updates.some((u) => u.sessionUpdate === "tool_call" && u.toolCallId === "1")).toBe(true);
  expect(await applyModEvent("s", { type: "turn_completed", reason: "answer" }, {
    client, tools, cwd: "/tmp", supportsTerminal: false,
  })).toBe("turn_completed");
});
