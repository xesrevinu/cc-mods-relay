import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { cancelCall, execute } from "../src/exec.js";
import { applyModEvent } from "../src/mod-live.js";
import { mapPath, rewriteRemoteText } from "../src/tools/paths.js";

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

test("Monitor runs the command locally instead of denying", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  const frame = await run(dir, "Monitor", { command: "printf watched", timeout_ms: 8_000 }, { callId: "mon" });
  expect(frame.ok).toBe(true);
  expect(frame.result.stdout).toContain("watched");
});

test("LSP returns empty diagnostics instead of denying", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  writeFileSync(join(dir, "a.ts"), "const x = 1;\n");
  const frame = await run(dir, "LSP", { file_path: join(dir, "a.ts"), operation: "diagnostics" }, { callId: "lsp" });
  expect(frame.ok).toBe(true);
  expect(frame.result.diagnostics).toEqual([]);
});

test("EnterWorktree path switches session cwd; ExitWorktree restores", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  mkdirSync(join(dir, "wt"));
  writeFileSync(join(dir, "here.txt"), "root\n");
  writeFileSync(join(dir, "wt", "here.txt"), "tree\n");
  const entered = await run(dir, "EnterWorktree", { path: join(dir, "wt") }, { callId: "ew", sessionId: "wt-sess" });
  expect(entered.ok).toBe(true);
  const nested = await run(dir, "Read", { file_path: "here.txt" }, { callId: "ew-r", sessionId: "wt-sess" });
  expect(nested.result.file.content).toBe("tree");
  const exited = await run(dir, "ExitWorktree", {}, { callId: "ex", sessionId: "wt-sess" });
  expect(exited.ok).toBe(true);
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
