import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cancelAgent, cancelCall, cancelSession, execute } from "../src/exec.js";
import { createSubagentWatcher } from "../src/subagent-watcher.js";
import { createToolExecutor } from "../src/tool-executor.js";
import { IMAGE_MAX_OUTPUT_BYTES } from "../src/tools/image-compress.js";
import { GREP_CONTENT_BYTE_CAP } from "../src/tools/grep.js";
import { HYDRATE_MAX_BYTES } from "../src/tools/hydrate.js";
import { structuredPatch } from "../src/tools/patch.js";
import {
  applyModEvent,
  isReplDispatchResult,
  jsonlHasReplToolUse,
  openReplId,
  replModEventsFromMessage,
  withReplParent,
} from "../src/mod-live.js";
import { toolInfoFromToolUse } from "../src/tools.js";
import { aliasTaskOutput, encodeClaudeTaskDir, persistCwd, sessionCwd } from "../src/tools/bash.js";
import { REDUNDANT_CD_HINT } from "../src/tools/bash-intent.js";
import { mapPath, mapReadPath, mapWritePath, rewriteRemoteText } from "../src/tools/paths.js";
import { READ_CONTENT_BYTE_CAP } from "../src/tools/read.js";
import { nativeToolError, nativeToolResult } from "../src/tools/runtime.js";

function run(
  dir: string,
  tool: string,
  input: Record<string, unknown>,
  opts: { callId?: string; sessionId?: string; tuiRoot?: string; tuiEnv?: Record<string, string> } = {},
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
        tuiEnv: opts.tuiEnv,
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

test("nativeToolError uses in-schema failure fields instead of a successful fallback", () => {
  expect(nativeToolError("Bash", "Use the Read tool")).toEqual({
    stdout: "",
    stderr: "Use the Read tool",
    interrupted: false,
  });
  expect(nativeToolError("NotebookEdit", "Cell not found", { notebook_path: "/tmp/n.ipynb", edit_mode: "delete" })).toMatchObject({
    error: "Cell not found",
    new_source: "",
    notebook_path: "/tmp/n.ipynb",
    edit_mode: "delete",
  });
  expect(nativeToolError("Grep", "search failed")).toEqual({
    numFiles: 0,
    filenames: [],
    content: "search failed",
  });
  expect(nativeToolError("Glob", "oops")).toEqual({
    durationMs: 0,
    numFiles: 0,
    filenames: [],
    truncated: false,
  });
  const read = nativeToolError("Read", "File does not exist: /tmp/gone.md", { file_path: "/tmp/gone.md" });
  expect(read.type).toBe("text");
  expect((read.file as { content: string }).content).toBe("File does not exist: /tmp/gone.md");
  expect(nativeToolError("Write", "Permission denied: /tmp/a", { file_path: "/tmp/a" }).type).toBe("update");
  expect(nativeToolError("ExitWorktree", "uncommitted files", { action: "remove" })).toMatchObject({
    action: "remove",
    message: "uncommitted files",
  });
  expect(nativeToolError("EnterWorktree", "not a worktree")).toMatchObject({
    worktreePath: "",
    message: "not a worktree",
  });
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
  const jail = await run(dir, "Read", { file_path: "/etc/passwd" });
  expect(jail.ok).toBe(false);
  expect(jail.error.code).toBe("PATH_DENIED");
  const many = Array.from({ length: 2001 }, (_, i) => `L${i + 1}`).join("\n") + "\n";
  writeFileSync(join(dir, "big.txt"), many);
  const capped = await run(dir, "Read", { file_path: join(dir, "big.txt") });
  expect(capped.ok).toBe(true);
  expect(capped.result.file.numLines).toBe(2000);
  expect(capped.result.file.totalLines).toBe(2001);
  expect(capped.result.file.truncatedByTokenCap).toBe(true);
  const paged = await run(dir, "Read", { file_path: join(dir, "big.txt"), offset: 1, limit: 10 });
  expect(paged.result.file.truncatedByTokenCap).toBeUndefined();
  const fat = Array.from({ length: 1200 }, () => "x".repeat(2000)).join("\n") + "\n";
  writeFileSync(join(dir, "fat.jsonl"), fat);
  const bulky = await run(dir, "Read", { file_path: join(dir, "fat.jsonl") });
  expect(bulky.ok).toBe(true);
  expect(Buffer.byteLength(bulky.result.file.content, "utf8")).toBeLessThanOrEqual(READ_CONTENT_BYTE_CAP);
  expect(bulky.result.file.numLines).toBeLessThan(1200);
  expect(bulky.result.file.totalLines).toBe(1200);
  expect(bulky.result.file.truncatedByTokenCap).toBe(true);
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
  expect(() => mapPath(cwd, tui, "/etc/passwd")).toThrow(/outside/);
  expect(mapReadPath(cwd, tui, join(home, ".local/share/references-repos/nsh/x.rs"))).toBe(
    join(home, ".local/share/references-repos/nsh/x.rs"),
  );
  expect(mapReadPath(cwd, tui, "/Users/bob/.local/share/references-repos/nsh/x.rs")).toBe(
    join(home, ".local/share/references-repos/nsh/x.rs"),
  );
  expect(() => mapReadPath(cwd, tui, "../.ssh/id_rsa")).toThrow(/outside/);
  expect(() => mapReadPath(cwd, tui, "/etc/passwd")).toThrow(/outside/);
  expect(mapWritePath(cwd, tui, join(home, ".claude/projects/-Users-me-app/memory/note.md"))).toBe(
    join(home, ".claude/projects/-Users-me-app/memory/note.md"),
  );
  expect(mapWritePath(cwd, tui, join(home, ".claude/projects/-Users-me-app/sess.jsonl"))).toBe(
    join(home, ".claude/projects/-Users-me-app/sess.jsonl"),
  );
  expect(mapWritePath(cwd, tui, join(home, "Workspace/github/sibling/prebuild.py"))).toBe(
    join(home, "Workspace/github/sibling/prebuild.py"),
  );
  expect(mapWritePath(cwd, tui, "/Users/bob/Workspace/other/x.ts")).toBe(join(home, "Workspace/other/x.ts"));
  expect(mapWritePath(cwd, tui, "/tmp/cc-mods-relay.txt")).toBe("/tmp/cc-mods-relay.txt");
  expect(mapWritePath(cwd, tui, "/private/tmp/cc-mods-relay.txt")).toBe("/private/tmp/cc-mods-relay.txt");
  expect(mapWritePath(cwd, tui, "/var/tmp/cc-mods-relay.txt")).toBe("/var/tmp/cc-mods-relay.txt");
  expect(() => mapWritePath(cwd, tui, "../.ssh/id_rsa")).toThrow(/outside/);
  expect(() => mapWritePath(cwd, tui, "/etc/passwd")).toThrow(/outside/);
  expect(rewriteRemoteText("cd /Users/bob/Workspace/abc && ls", cwd, tui)).toBe("cd /Users/me/proj && ls");
  expect(rewriteRemoteText("cd /Users/bob/Workspace/abc-extra", cwd, tui)).toBe(`cd ${home}/Workspace/abc-extra`);
  expect(rewriteRemoteText("cd ~/Workspace/abc && pwd", cwd, tui)).toBe("cd /Users/me/proj && pwd");
  expect(rewriteRemoteText("cat ~/.cursor/artifacts/x.sh", cwd, tui)).toBe(`cat ${home}/.cursor/artifacts/x.sh`);
  expect(rewriteRemoteText("cd ~ && ls", cwd, tui)).toBe(`cd ${home} && ls`);
  expect(rewriteRemoteText("export PATH=~/bin:$HOME/bin", cwd, tui)).toBe(`export PATH=${home}/bin:${home}/bin`);
  expect(rewriteRemoteText("token~ : Int32 = 0", cwd, tui)).toBe("token~ : Int32 = 0");
  expect(rewriteRemoteText("[[ $x =~ foo ]]", cwd, tui)).toBe("[[ $x =~ foo ]]");
  expect(rewriteRemoteText("rm file.txt~", cwd, tui)).toBe("rm file.txt~");
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

test("Bash keeps a redundant leading cd successful and notes it on stderr", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  const kept = await run(dir, "Bash", { command: `cd '${dir}' && printf hi` }, { callId: "cd-hint" });
  expect(kept.ok).toBe(true);
  expect(kept.result.stdout).toBe("hi");
  expect(kept.result.stderr).toContain(REDUNDANT_CD_HINT);
  expect(kept.result.interrupted).toBe(false);
  const only = await run(dir, "Bash", { command: `cd '${dir}'` }, { callId: "cd-only" });
  expect(only.ok).toBe(true);
  expect(only.result.stderr).toContain(REDUNDANT_CD_HINT);
  const real = await run(dir, "Bash", { command: "cd /tmp && printf x" }, { callId: "cd-other" });
  expect(real.ok).toBe(true);
  expect(real.result.stdout).toBe("x");
  expect(real.result.stderr).not.toContain(REDUNDANT_CD_HINT);
});

test("Bash overlays Mini TZ/LANG and drops client secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  const prev = {
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    TZ: process.env.TZ,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    TERM: process.env.TERM,
  };
  process.env.AWS_SECRET_ACCESS_KEY = "client-secret";
  process.env.TZ = "Asia/Shanghai";
  process.env.LANG = "zh_CN.UTF-8";
  process.env.LC_ALL = "zh_CN.UTF-8";
  process.env.TERM = "dumb";
  try {
    const locale = await run(
      dir,
      "Bash",
      { command: 'printf "%s %s %s %s %s" "$TZ" "$LANG" "${LC_ALL-}" "$TERM" "$(date +%z)"' },
      {
        tuiEnv: { TZ: "Asia/Tokyo", LANG: "en_US.UTF-8", TERM: "xterm-256color", COLORTERM: "truecolor", FORCE_COLOR: "3" },
        callId: "locale",
      },
    );
    expect(locale.ok).toBe(true);
    expect(locale.result.stdout.trim()).toBe("Asia/Tokyo en_US.UTF-8  xterm-256color +0900");
    const leak = await run(
      dir,
      "Bash",
      { command: 'printenv AWS_SECRET_ACCESS_KEY || true' },
      { tuiEnv: { TZ: "Asia/Tokyo" }, callId: "secret" },
    );
    expect(leak.ok).toBe(true);
    expect(leak.result.stdout.trim()).toBe("");
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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

test("aborting a subagent cancels only that agent's Bash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  const started = Date.now();
  const pending = new Promise<any>((resolve) => {
    void execute(
      {
        tool: "Bash",
        input: { command: "sleep 8" },
        cwd: dir,
        tuiRoot: dir,
        callId: "agent-sleep",
        sessionId: "sess",
        agentId: "agent-kill-me",
      },
      (frame) => resolve(frame),
    );
  });
  await Bun.sleep(80);
  cancelAgent("agent-kill-me");
  const frame = await pending;
  expect(frame.ok).toBe(true);
  expect(frame.result.interrupted).toBe(true);
  expect(Date.now() - started).toBeLessThan(5_000);
});

test("Read and Write of an explicit $HOME path outside the project are allowed", async () => {
  const dir = mkdtempSync(join(homedir(), ".cc-mods-relay-proj-"));
  const outside = join(homedir(), `.cc-mods-relay-read-${process.pid}.txt`);
  writeFileSync(outside, "reference\n");
  try {
    const got = await run(dir, "Read", { file_path: outside });
    expect(got.ok).toBe(true);
    expect(got.result.file.content).toContain("reference");
    const wrote = await run(dir, "Write", { file_path: outside, content: "updated\n" });
    expect(wrote.ok).toBe(true);
    expect(await Bun.file(outside).text()).toBe("updated\n");
    const relative = await run(dir, "Write", { file_path: "../pwn.txt", content: "nope\n" });
    expect(relative.ok).toBe(false);
    expect(relative.error.code).toBe("PATH_DENIED");
    const etc = await run(dir, "Write", { file_path: "/etc/passwd", content: "nope\n" });
    expect(etc.ok).toBe(false);
    expect(etc.error.code).toBe("PATH_DENIED");
  } finally {
    rmSync(outside, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Write to Claude Code project memory and other explicit home files is allowed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  const dest = join(homedir(), ".claude", "projects", "cc-mods-relay-test", "memory", "note.md");
  const jsonl = join(homedir(), ".claude", "projects", "cc-mods-relay-test", "sess.jsonl");
  try {
    const wrote = await run(dir, "Write", { file_path: dest, content: "remember\n" }, { callId: "mem" });
    expect(wrote.ok).toBe(true);
    expect(await Bun.file(dest).text()).toBe("remember\n");
    const sibling = await run(dir, "Write", { file_path: jsonl, content: "{}\n" }, { callId: "jsonl" });
    expect(sibling.ok).toBe(true);
    expect(await Bun.file(jsonl).text()).toBe("{}\n");
  } finally {
    rmSync(join(homedir(), ".claude", "projects", "cc-mods-relay-test"), { recursive: true, force: true });
  }
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

test("cd into ~/.local/share is persisted for later Write", async () => {
  const dir = mkdtempSync(join(homedir(), ".cc-mods-relay-proj-"));
  mkdirSync(join(homedir(), ".local", "share"), { recursive: true });
  const share = mkdtempSync(join(homedir(), ".local", "share", "cc-mods-relay-"));
  try {
    const cd = await run(dir, "Bash", { command: `cd "${share}"` }, { callId: "share-cd", sessionId: "share-sess" });
    expect(cd.ok).toBe(true);
    const wrote = await run(dir, "Write", { file_path: "out.txt", content: "share\n" }, { callId: "share-w", sessionId: "share-sess" });
    expect(wrote.ok).toBe(true);
    expect(existsSync(join(dir, "out.txt"))).toBe(false);
    expect(readFileSync(join(share, "out.txt"), "utf8")).toBe("share\n");
  } finally {
    rmSync(share, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Write to /tmp and other common temp dirs is allowed", async () => {
  const dir = mkdtempSync(join(homedir(), ".cc-mods-relay-proj-"));
  const stamp = `${process.pid}-${Date.now()}`;
  const tmpFile = `/tmp/cc-mods-relay-${stamp}.txt`;
  const varFile = `/var/tmp/cc-mods-relay-${stamp}.txt`;
  const relName = `cc-mods-relay-rel-${stamp}.txt`;
  try {
    expect(mapWritePath(dir, undefined, tmpFile)).toBe(resolve(tmpFile));
    expect(mapWritePath(dir, undefined, `/private${tmpFile}`)).toBe(resolve(`/private${tmpFile}`));
    const wrote = await run(dir, "Write", { file_path: tmpFile, content: "tmp\n" }, { callId: "tmp-w" });
    expect(wrote.ok).toBe(true);
    expect(await Bun.file(tmpFile).text()).toBe("tmp\n");
    const varWrote = await run(dir, "Write", { file_path: varFile, content: "vartmp\n" }, { callId: "var-w" });
    expect(varWrote.ok).toBe(true);
    expect(await Bun.file(varFile).text()).toBe("vartmp\n");
    const cd = await run(dir, "Bash", { command: "cd /tmp" }, { callId: "tmp-cd", sessionId: "tmp-sess" });
    expect(cd.ok).toBe(true);
    const rel = await run(dir, "Write", { file_path: relName, content: "rel\n" }, { callId: "tmp-rel", sessionId: "tmp-sess" });
    expect(rel.ok).toBe(true);
    expect(existsSync(join(dir, relName))).toBe(false);
    expect(readFileSync(join("/tmp", relName), "utf8")).toBe("rel\n");
  } finally {
    rmSync(tmpFile, { force: true });
    rmSync(`/private${tmpFile}`, { force: true });
    rmSync(varFile, { force: true });
    rmSync(join("/tmp", relName), { force: true });
    rmSync(join("/private/tmp", relName), { force: true });
    rmSync(dir, { recursive: true, force: true });
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

test("Bash cd outside write roots is not persisted for later Write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  const outside = mkdtempSync(join(homedir(), ".cc-mods-relay-jail-"));
  try {
    const cd = await run(dir, "Bash", { command: `cd "${outside}"` }, { callId: "jail-cd", sessionId: "jail-sess" });
    expect(cd.ok).toBe(true);
    const write = await run(dir, "Write", { file_path: "pwn.txt", content: "nope" }, { callId: "jail-w", sessionId: "jail-sess" });
    expect(write.ok).toBe(true);
    expect(existsSync(join(outside, "pwn.txt"))).toBe(false);
    expect(readFileSync(join(dir, "pwn.txt"), "utf8")).toBe("nope");
    persistCwd(dir, "jail-direct", outside);
    expect(sessionCwd({ sessionId: "jail-direct", cwd: dir }, dir)).toBe(dir);
    mkdirSync(join(dir, "sub"));
    persistCwd(dir, "jail-sub", join(dir, "sub"));
    expect(sessionCwd({ sessionId: "jail-sub", cwd: dir }, dir)).toBe(realpathSync(join(dir, "sub")));
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
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

test("encodeClaudeTaskDir matches Claude Code's /tmp/claude-<uid>/ folder", () => {
  expect(encodeClaudeTaskDir("/Users/kee/.cursor/worktrees/holt/herdr-moonbit-migration")).toBe(
    "-Users-kee--cursor-worktrees-holt-herdr-moonbit-migration",
  );
  expect(encodeClaudeTaskDir("/Users/alice/my_proj")).toBe("-Users-alice-my-proj");
});

test("Bash background writes Claude Code tasks/<pid>.output and stamps agentId on notify", async () => {
  if (process.platform === "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const uid = process.getuid!();
  const frames: any[] = [];
  const frame = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Bash did not return")), 6_000);
    void execute(
      {
        tool: "Bash",
        input: { command: "printf 'bg-ready\\n'", run_in_background: true },
        cwd: dir,
        tuiRoot: dir,
        callId: "bg-task-file",
        sessionId: "inst-1",
        claudeSessionId: sessionId,
        tuiUid: String(uid),
        agentId: "agent-sub-1",
      },
      (next) => {
        frames.push(next);
        if (next.type === "result") {
          clearTimeout(timer);
          resolve(next);
        }
      },
      (next) => frames.push(next),
    );
  });
  expect(frame.ok).toBe(true);
  const pid = String(frame.result.backgroundTaskId);
  const expected = join("/tmp", `claude-${uid}`, encodeClaudeTaskDir(dir), sessionId, "tasks", `${pid}.output`);
  expect(String(frame.result.stdout)).toContain(expected);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !frames.some((f) => f.kind === "background" && String(f.output || "").includes("bg-ready"))) {
    await Bun.sleep(20);
  }
  const note = frames.find((f) => f.kind === "background");
  expect(note?.agentId).toBe("agent-sub-1");
  expect(note?.output).toContain("bg-ready");
  expect(note?.outputFile).toBe(expected);
  expect(existsSync(expected)).toBe(true);
  expect(readFileSync(expected, "utf8")).toContain("bg-ready");
  rmSync(join("/tmp", `claude-${uid}`, encodeClaudeTaskDir(dir), sessionId), { recursive: true, force: true });
});

test("Bash background task files encode Mini tuiRoot, not the Mac cwd", async () => {
  if (process.platform === "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  const tui = "/Users/bob/Workspace/abc";
  const sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const uid = process.getuid!();
  const frames: any[] = [];
  const frame = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Bash did not return")), 6_000);
    void execute(
      {
        tool: "Bash",
        input: { command: "printf 'tui-root\\n'", run_in_background: true },
        cwd: dir,
        tuiRoot: tui,
        callId: "bg-tui-root",
        sessionId: "inst-2",
        claudeSessionId: sessionId,
        tuiUid: String(uid),
      },
      (next) => {
        frames.push(next);
        if (next.type === "result") {
          clearTimeout(timer);
          resolve(next);
        }
      },
      (next) => frames.push(next),
    );
  });
  expect(frame.ok).toBe(true);
  const pid = String(frame.result.backgroundTaskId);
  const expected = join("/tmp", `claude-${uid}`, encodeClaudeTaskDir(tui), sessionId, "tasks", `${pid}.output`);
  expect(String(frame.result.stdout)).toContain(expected);
  expect(String(frame.result.stdout)).not.toContain(encodeClaudeTaskDir(dir));
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !existsSync(expected)) await Bun.sleep(20);
  expect(existsSync(expected)).toBe(true);
  rmSync(join("/tmp", `claude-${uid}`, encodeClaudeTaskDir(tui), sessionId), { recursive: true, force: true });
});

test("Bash background does not guess Mac uid when tuiUid is missing", async () => {
  if (process.platform === "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  const sessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const uid = process.getuid!();
  const frame = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Bash did not return")), 6_000);
    void execute(
      {
        tool: "Bash",
        input: { command: "printf 'no-uid\\n'", run_in_background: true },
        cwd: dir,
        tuiRoot: dir,
        callId: "bg-no-uid",
        sessionId: "inst-3",
        claudeSessionId: sessionId,
        tuiUid: "",
      },
      (next) => {
        if (next.type === "result") {
          clearTimeout(timer);
          resolve(next);
        }
      },
    );
  });
  expect(frame.ok).toBe(true);
  const stdout = String(frame.result.stdout);
  expect(stdout).not.toContain(`/tmp/claude-${uid}/`);
  expect(stdout).toContain("cc-mods-bg-");
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

test("REPL tool calls show as Code with the JavaScript", () => {
  const info = toolInfoFromToolUse({
    id: "repl1",
    name: "REPL",
    input: { code: "await edit(target, \"a\", \"b\");" },
  });
  expect(info.title).toBe("Code");
  expect(info.kind).toBe("execute");
  expect(JSON.stringify(info.content)).toContain("await edit");
});

test("JSONL REPL rows become live mod events and nest inner tools", () => {
  const started = replModEventsFromMessage({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "r1", name: "REPL", input: { code: "await file(p).text()" } }] },
  });
  expect(started).toEqual([{ type: "tool_started", toolUseId: "r1", tool: "REPL", input: { code: "await file(p).text()" } }]);
  expect(isReplDispatchResult("(dispatched #1)")).toBe(true);
  expect(isReplDispatchResult("ok")).toBe(false);
  const tools = new Map<string, { tool: string; input: Record<string, unknown> }>([
    ["r1", { tool: "REPL", input: {} }],
  ]);
  expect(openReplId(tools)).toBe("r1");
  expect(withReplParent({ type: "tool_started", toolUseId: "b1", tool: "Bash", input: {} }, "r1")).toMatchObject({
    parentToolUseId: "r1",
  });
  expect(withReplParent({ type: "tool_started", toolUseId: "r1", tool: "REPL", input: {} }, "r1").parentToolUseId).toBeUndefined();
  expect(withReplParent({ type: "tool_finished", toolUseId: "r1" }, "r1").parentToolUseId).toBeUndefined();
  expect(jsonlHasReplToolUse({
    type: "assistant",
    message: { stop_reason: "end_turn", content: [{ type: "tool_use", id: "r1", name: "REPL", input: {} }] },
  })).toBe(true);
  expect(jsonlHasReplToolUse({
    type: "assistant",
    message: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
  })).toBe(false);
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

test("ACP shows a failed Read as error text, not numbered file contents", async () => {
  const updates: any[] = [];
  const client = { sessionUpdate: async (note: any) => { updates.push(note.update); } };
  const tools = new Map<string, { tool: string; input: Record<string, unknown> }>();
  const ctx = { client, tools, cwd: "/tmp", supportsTerminal: false };
  await applyModEvent("s", { type: "tool_started", toolUseId: "r", tool: "Read", input: { file_path: "/tmp/gone.md" } }, ctx);
  await applyModEvent("s", {
    type: "tool_finished",
    toolUseId: "r",
    isError: true,
    error: "File does not exist: /tmp/gone.md",
    result: {
      type: "text",
      file: { filePath: "/tmp/gone.md", content: "File does not exist: /tmp/gone.md", numLines: 1, startLine: 1, totalLines: 1 },
    },
  }, ctx);
  const done = updates.find((u) => u.sessionUpdate === "tool_call_update" && u.status === "failed");
  expect(done?.status).toBe("failed");
  const text = done?.content?.[0]?.content?.text as string;
  expect(text).toContain("File does not exist: /tmp/gone.md");
  expect(text).not.toMatch(/^1\t/);
});

test("Grep on a single file and with -C context returns clean filenames", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  const file = join(dir, "single.ts");
  writeFileSync(file, "one\nhit-alpha\ntwo\nthree\nfour\nhit-alpha\nfive\n");
  try {
    const content = await run(dir, "Grep", { pattern: "hit-alpha", path: file, output_mode: "content", "-C": 1 });
    expect(content.ok).toBe(true);
    expect(content.result.filenames).toEqual([file]);
    const count = await run(dir, "Grep", { pattern: "hit-alpha", path: file, output_mode: "count" });
    expect(count.ok).toBe(true);
    expect(count.result.filenames).toEqual([file]);
    expect(count.result.numMatches).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mapReadPath allows read-only SDK/toolchain dirs while keeping Write jailed", () => {
  const cwd = "/Users/me/proj";
  expect(mapReadPath(cwd, cwd, "/usr/include/stdio.h")).toBe("/usr/include/stdio.h");
  expect(mapReadPath(cwd, cwd, "/Applications/Xcode.app/Contents/Developer/x.h")).toBe(
    "/Applications/Xcode.app/Contents/Developer/x.h",
  );
  expect(() => mapReadPath(cwd, cwd, "/etc/passwd")).toThrow(/outside/);
  expect(() => mapWritePath(cwd, cwd, "/usr/include/stdio.h")).toThrow(/outside/);
  expect(() => mapWritePath(cwd, cwd, "/Applications/Xcode.app/Contents/x.h")).toThrow(/outside/);
});

test("Write and Edit drop large originalFile/diff from tool result while writing full content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tools-"));
  const big = "a".repeat(600_000);
  const file = join(dir, "large.txt");
  try {
    const created = await run(dir, "Write", { file_path: file, content: `${big}1` });
    expect(created.ok).toBe(true);
    expect(created.result.originalFile).toBeNull();
    expect(created.result.structuredPatch).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(`${big}1`);
    const edited = await run(dir, "Edit", { file_path: file, old_string: "a1", new_string: "a2" });
    expect(edited.ok).toBe(true);
    expect(edited.result.originalFile).toBeNull();
    expect(edited.result.structuredPatch).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(`${big}2`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("subagent Bash cd does not clobber parent session cwd", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cc-tools-")));
  const sub = join(dir, "sub");
  mkdirSync(sub);
  try {
    const parentFrame = { tool: "Bash", input: { command: "pwd" }, cwd: dir, tuiRoot: dir, callId: "p1", sessionId: "iso-sub" };
    const subFrame = { tool: "Bash", input: { command: `cd "${sub}" && pwd` }, cwd: dir, tuiRoot: dir, callId: "s1", sessionId: "iso-sub", agentId: "agent-1" };
    const sRes = await new Promise<any>((resolve) => execute(subFrame, resolve));
    expect(sRes.ok).toBe(true);
    expect(sRes.result.stdout.trim()).toBe(realpathSync(sub));
    const pRes = await new Promise<any>((resolve) => execute(parentFrame, resolve));
    expect(pRes.ok).toBe(true);
    expect(pRes.result.stdout.trim()).toBe(realpathSync(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Glob respects .gitignore and skips common build dirs unless explicitly targeted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-glob-ign-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "target", "debug"), { recursive: true });
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, ".gitignore"), "ignored-dir/\n*.log\n");
    mkdirSync(join(dir, "ignored-dir"));
    writeFileSync(join(dir, "src", "keep.ts"), "ok\n");
    writeFileSync(join(dir, "ignored-dir", "drop.ts"), "no\n");
    writeFileSync(join(dir, "debug.log"), "no\n");
    writeFileSync(join(dir, "target", "debug", "build.ts"), "no\n");
    writeFileSync(join(dir, "dist", "out.ts"), "no\n");

    const all = await run(dir, "Glob", { pattern: "**/*.ts", path: dir });
    expect(all.ok).toBe(true);
    expect(all.result.filenames).toEqual([join(dir, "src", "keep.ts")]);

    const targeted = await run(dir, "Glob", { pattern: "target/**/*.ts", path: dir });
    expect(targeted.ok).toBe(true);
    expect(targeted.result.filenames).toEqual([join(dir, "target", "debug", "build.ts")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Read streams offset/limit cleanly on large files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-read-stream-"));
  const file = join(dir, "huge.log");
  try {
    const line = "x".repeat(400);
    const body = Array.from({ length: 800 }, (_, i) => `L${i + 1}:${line}`).join("\n") + "\n"; // > 320 KiB
    writeFileSync(file, body);
    const page = await run(dir, "Read", { file_path: file, offset: 500, limit: 3 });
    expect(page.ok).toBe(true);
    expect(page.result.file.numLines).toBe(3);
    expect(page.result.file.startLine).toBe(500);
    expect(page.result.file.content).toContain("L500:");
    expect(page.result.file.content).toContain("L502:");
    expect(page.result.file.content).not.toContain("L503:");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("IMAGE_MAX_OUTPUT_BYTES stays under Mods ~4 MiB hook-join limit", () => {
  expect(IMAGE_MAX_OUTPUT_BYTES).toBeLessThanOrEqual(2.5 * 1024 * 1024);
});

test("subagent-watcher stops polling after all spawned subagents complete and resumes on new spawn", async () => {
  let listCalls = 0;
  let activity = 0;
  const openMsg = {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "ag1", name: "Agent", input: {} }] },
  };
  const closedMsg = {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "ag1", content: "done" }] },
  };
  const watcher = createSubagentWatcher({
    sessionId: "s-sub",
    mainChain: [openMsg as any],
    pollMs: 15,
    listSubagents: async () => {
      listCalls += 1;
      return ["sub-1"];
    },
    getSubagentMessages: async () => [{ uuid: `u-${listCalls}`, type: "assistant" } as any],
    onActivity: () => {
      activity += 1;
    },
  });
  try {
    await Bun.sleep(55);
    expect(listCalls).toBeGreaterThanOrEqual(2);
    expect(activity).toBeGreaterThanOrEqual(1);
    watcher.update([openMsg as any, closedMsg as any]);
    await Bun.sleep(45);
    const frozen = listCalls;
    await Bun.sleep(60);
    expect(listCalls).toBe(frozen);
    watcher.update([
      openMsg as any,
      closedMsg as any,
      { type: "assistant", message: { content: [{ type: "tool_use", id: "ag2", name: "Agent", input: {} }] } } as any,
    ]);
    await Bun.sleep(45);
    expect(listCalls).toBeGreaterThan(frozen);
  } finally {
    watcher.stop();
  }
});

test("Bash returns promptly when a backgrounded subshell inherits pipes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-bg-pipe-"));
  const sentinel = join(dir, "done.txt");
  const started = Date.now();
  try {
    const res = await run(dir, "Bash", {
      command: `rm -f '${sentinel}' && nohup bash -c "sleep 2; echo ok > '${sentinel}'" >/dev/null 2>&1 &`,
      timeout: 5_000,
    });
    expect(res.ok).toBe(true);
    expect(res.result.backgroundTaskId).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bash never auto-backgrounds leading sleep and respects CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-no-autobg-"));
  try {
    const slept = await run(dir, "Bash", { command: "sleep 5", timeout: 150 });
    expect(slept.ok).toBe(true);
    expect(slept.result.backgroundTaskId).toBeUndefined();
    expect(slept.result.stderr).toMatch(/timed out after 150ms/i);

    const prev = process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;
    process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
    try {
      const disabled = await run(dir, "Bash", { command: "echo hi; sleep 5", timeout: 150 });
      expect(disabled.ok).toBe(true);
      expect(disabled.result.backgroundTaskId).toBeUndefined();
      expect(disabled.result.stderr).toMatch(/timed out after 150ms/i);

      const explicitBg = await run(dir, "Bash", { command: "echo hi", run_in_background: true });
      expect(explicitBg.ok).toBe(false);
      expect(explicitBg.error.message).toMatch(/Background tasks are disabled/i);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;
      else process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("turn-scoped cancel kills foreground Bash while keeping background Bash alive and aliasing output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-turn-cancel-"));
  const sessionId = `turn-cancel-${Date.now()}`;
  const notes: any[] = [];
  const bgDone = new Promise<any>((resolve) => {
    const send = (frame: any) => {
      if (frame.type === "notify") {
        notes.push(frame);
        resolve(frame);
      }
    };
    void execute(
      {
        tool: "Bash",
        input: { command: "sleep 0.35; echo bg-survived", run_in_background: true },
        cwd: dir,
        tuiRoot: dir,
        callId: "bg-keep",
        sessionId,
        claudeSessionId: "00000000-0000-0000-0000-000000000099",
        tuiUid: 99999,
      },
      () => {},
      send,
    );
  });

  const fgPromise = new Promise<any>((resolve) => {
    void execute(
      {
        tool: "Bash",
        input: { command: "sleep 8" },
        cwd: dir,
        tuiRoot: dir,
        callId: "fg-kill",
        sessionId,
      },
      (frame) => resolve(frame),
    );
  });

  await Bun.sleep(100);
  aliasTaskOutput("bg-keep", "mini-task-77");
  cancelSession(sessionId, { includeBackground: false });

  const fg = await fgPromise;
  expect(fg.ok).toBe(true);
  expect(fg.result.interrupted).toBe(true);

  const note = await bgDone;
  expect(note.interrupted).toBe(false);
  expect(note.exitCode).toBe(0);
  expect(note.output).toContain("bg-survived");
  if (typeof note.outputFile === "string") {
    const aliasPath = join(note.outputFile, "..", "mini-task-77.output");
    expect(existsSync(aliasPath)).toBe(true);
    expect(readFileSync(aliasPath, "utf8")).toContain("bg-survived");
    rmSync(join("/tmp", "claude-99999"), { recursive: true, force: true });
  }
  rmSync(dir, { recursive: true, force: true });
});

test("structuredPatch emits contextual hunks without phantom trailing empty lines", () => {
  const before = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join("\n") + "\n";
  const after = before.replace("line-10", "line-10-changed");
  const hunks = structuredPatch(before, after);
  expect(hunks).toHaveLength(1);
  expect(hunks[0]!.oldStart).toBe(7);
  expect(hunks[0]!.oldLines).toBe(7);
  expect(hunks[0]!.newLines).toBe(7);
  expect(hunks[0]!.lines).toContain("-line-10");
  expect(hunks[0]!.lines).toContain("+line-10-changed");
  expect(hunks[0]!.lines).not.toContain("-line-1");

  const eofEdit = structuredPatch("a\nb\n", "a\nc\n");
  expect(eofEdit).toEqual([{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" a", "-b", "+c"] }]);

  const created = structuredPatch("", "a\nb\n");
  expect(created).toEqual([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+a", "+b"] }]);
});

test("Grep supports multi-glob, caps huge output, and omits undefined optional keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-grep-multi-"));
  try {
    writeFileSync(join(dir, "a.ts"), "needle-ts\n");
    writeFileSync(join(dir, "b.md"), "needle-md\n");
    writeFileSync(join(dir, "c.txt"), "needle-txt\n");
    const multi = await run(dir, "Grep", { pattern: "needle", path: dir, glob: "*.ts *.md", head_limit: 0 });
    expect(multi.ok).toBe(true);
    expect(multi.result.filenames.sort()).toEqual([join(dir, "a.ts"), join(dir, "b.md")].sort());
    expect("appliedLimit" in multi.result).toBe(false);
    expect("appliedOffset" in multi.result).toBe(false);

    const bigLine = `hit-${"x".repeat(400)}\n`;
    writeFileSync(join(dir, "huge.log"), bigLine.repeat(5000));
    const capped = await run(dir, "Grep", {
      pattern: "hit-",
      path: join(dir, "huge.log"),
      output_mode: "content",
      head_limit: 0,
    });
    expect(capped.ok).toBe(true);
    expect(Buffer.byteLength(capped.result.content, "utf8")).toBeLessThanOrEqual(GREP_CONTENT_BYTE_CAP + 256);
    expect(capped.result.content).toContain("truncated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Read paged stream reports accurate totalLines on large files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-read-total-"));
  const file = join(dir, "big.txt");
  try {
    const body = Array.from({ length: 3000 }, (_, i) => `L${String(i + 1).padStart(4, "0")} ${"x".repeat(100)}`).join("\n") + "\n";
    writeFileSync(file, body);
    const res = await run(dir, "Read", { file_path: file, offset: 5, limit: 10 });
    expect(res.ok).toBe(true);
    expect(res.result.file.numLines).toBe(10);
    expect(res.result.file.startLine).toBe(5);
    expect(res.result.file.totalLines).toBe(3000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hydrate rejects files exceeding HYDRATE_MAX_BYTES", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-hydrate-cap-"));
  const file = join(dir, "huge.bin");
  try {
    writeFileSync(file, Buffer.alloc(HYDRATE_MAX_BYTES + 16, 65));
    const res = await run(dir, "hydrate", { file_path: file });
    expect(res.ok).toBe(false);
    expect(res.error.message).toMatch(/hydrate limit/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool-executor serializes relative+absolute Edits and rejects inflight CALL_ID_CONFLICT", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-exec-ser-"));
  const abs = join(dir, "f.txt");
  writeFileSync(abs, "alpha\nbeta\n");
  const exec = createToolExecutor();
  exec.bind("s-ser", dir, dir);
  try {
    const out: any[] = [];
    const done = new Promise<void>((resolve) => {
      const send = (m: any) => {
        out.push(m);
        if (out.length === 2) resolve();
      };
      exec.handle({ type: "call", callId: "ed-rel", tool: "Edit", input: { file_path: "f.txt", old_string: "alpha", new_string: "ALPHA" } }, send, send);
      exec.handle({ type: "call", callId: "ed-abs", tool: "Edit", input: { file_path: abs, old_string: "beta", new_string: "BETA" } }, send, send);
    });
    await done;
    expect(readFileSync(abs, "utf8")).toBe("ALPHA\nBETA\n");

    const conflict: any[] = [];
    const slowDone = new Promise<void>((resolve) => {
      exec.handle(
        { type: "call", callId: "dup-1", tool: "Bash", input: { command: "sleep 0.2; echo ok" } },
        (m) => { conflict.push(m); if (conflict.length >= 2) resolve(); },
        () => {},
      );
      exec.handle(
        { type: "call", callId: "dup-1", tool: "Bash", input: { command: "echo different" } },
        (m) => { conflict.push(m); if (conflict.length >= 2) resolve(); },
        () => {},
      );
    });
    await slowDone;
    expect(conflict.some((m) => m.ok === false && m.error?.code === "CALL_ID_CONFLICT")).toBe(true);
    expect(conflict.some((m) => m.ok === true)).toBe(true);
  } finally {
    exec.cancelAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aliasTaskOutput still symlinks after a fast-exiting background Bash finishes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-fast-alias-"));
  const callId = `fast-bg-${Date.now()}`;
  try {
    const exited = new Promise<any>((resolve) => {
      void execute(
        {
          tool: "Bash",
          input: { command: "echo fast-done", run_in_background: true },
          cwd: dir,
          tuiRoot: dir,
          callId,
          sessionId: "s-fast",
          claudeSessionId: "00000000-0000-0000-0000-000000000088",
          tuiUid: 99998,
        },
        () => {},
        (frame) => {
          if (frame.type === "notify") resolve(frame);
        },
      );
    });
    const note = await exited;
    aliasTaskOutput(callId, "mini-late-88");
    const aliasPath = join(note.outputFile, "..", "mini-late-88.output");
    expect(existsSync(aliasPath)).toBe(true);
    expect(readFileSync(aliasPath, "utf8")).toContain("fast-done");
  } finally {
    rmSync(join("/tmp", "claude-99998"), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main-session resetSessionCwd does not wipe active subagent cwd", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cc-sub-cwd-")));
  const sub = join(dir, "sub");
  mkdirSync(sub);
  const sid = `sess-sub-iso-${Date.now()}`;
  try {
    persistCwd(dir, sid, sub, [], true, "agent-sub-1");
    persistCwd(dir, sid, sub, [], true);
    expect(sessionCwd({ sessionId: sid, agentId: "agent-sub-1", cwd: dir }, dir)).toBe(sub);
    // Calling resetSessionCwd without allAgents only resets main session
    const { resetSessionCwd } = require("../src/tools/bash.js");
    resetSessionCwd(sid);
    expect(sessionCwd({ sessionId: sid, cwd: dir }, dir)).toBe(dir);
    expect(sessionCwd({ sessionId: sid, agentId: "agent-sub-1", cwd: dir }, dir)).toBe(sub);
    resetSessionCwd(sid, undefined, { allAgents: true });
    expect(sessionCwd({ sessionId: sid, agentId: "agent-sub-1", cwd: dir }, dir)).toBe(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Edit matches LF old_string against CRLF files and preserves CRLF", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-edit-crlf-"));
  const file = join(dir, "win.txt");
  writeFileSync(file, "line1\r\nline2\r\nline3\r\n");
  try {
    const res = await run(dir, "Edit", {
      file_path: file,
      old_string: "line1\nline2",
      new_string: "line1\nline2-edited",
    });
    expect(res.ok).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("line1\r\nline2-edited\r\nline3\r\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Grep hyphenated dir with -n:false context and *.gitignore glob keep clean filenames and skip .git", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-grep-dash-dir-"));
  try {
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "config"), "needle-in-git\n");
    writeFileSync(join(dir, "sample.txt"), "before\nneedle-hit\nafter\n");

    const dash = await run(dir, "Grep", {
      pattern: "needle-hit",
      path: dir,
      output_mode: "content",
      "-n": false,
      "-C": 1,
    });
    expect(dash.ok).toBe(true);
    expect(dash.result.filenames).toEqual([join(dir, "sample.txt")]);
    expect(dash.result.numFiles).toBe(1);

    // Before- and after-context lines containing `:` must not be misparsed as filenames when -n:false.
    writeFileSync(join(dir, "typed.ts"), "const before: number = 1;\nconst target = 2;\nconst after: string = 'x';\n");
    const colonCtx = await run(dir, "Grep", {
      pattern: "const target = 2",
      path: dir,
      output_mode: "content",
      "-n": false,
      "-C": 1,
    });
    expect(colonCtx.ok).toBe(true);
    expect(colonCtx.result.filenames).toEqual([join(dir, "typed.ts")]);
    expect(colonCtx.result.numFiles).toBe(1);

    const gitignoreGlob = await run(dir, "Grep", {
      pattern: "needle",
      path: dir,
      glob: "*.gitignore *.txt",
    });
    expect(gitignoreGlob.ok).toBe(true);
    expect(gitignoreGlob.result.filenames).toEqual([join(dir, "sample.txt")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Glob pattern containing 'build' substring still respects .gitignore", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-glob-sub-"));
  try {
    mkdirSync(join(dir, "ignored"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, ".gitignore"), "ignored/\n");
    writeFileSync(join(dir, "ignored", "rebuild.ts"), "no\n");
    writeFileSync(join(dir, "src", "rebuild.ts"), "yes\n");
    const res = await run(dir, "Glob", { pattern: "**/*build*.ts", path: dir });
    expect(res.ok).toBe(true);
    expect(res.result.filenames).toEqual([join(dir, "src", "rebuild.ts")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rewriteRemotePath does not corrupt $HOMEBREW_PREFIX", () => {
  expect(rewriteRemoteText("$HOMEBREW_PREFIX/bin/bun", "/Users/me/proj", "/Users/mini/proj")).toBe(
    "$HOMEBREW_PREFIX/bin/bun",
  );
  const { rewriteRemotePath } = require("../src/tools/paths.js");
  expect(rewriteRemotePath("$HOMEBREW_PREFIX/bin/bun", "/Users/me/proj", "/Users/mini/proj")).toBe(
    "$HOMEBREW_PREFIX/bin/bun",
  );
});

test("REPL Read omits truncatedByTokenCap and reads >2000 lines without triggering hook_parts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-read-repl-"));
  const file = join(dir, "emit.mbt");
  try {
    const body = Array.from({ length: 2600 }, (_, i) => `fn line_${i + 1}() -> Unit { () }`).join("\n") + "\n";
    writeFileSync(file, body);
    const normal = await run(dir, "Read", { file_path: file }, { callId: "toolu_01normal" });
    expect(normal.ok).toBe(true);
    expect(normal.result.file.numLines).toBe(2000);
    expect(normal.result.file.totalLines).toBe(2600);
    expect(normal.result.file.truncatedByTokenCap).toBe(true);

    const repl = await run(dir, "Read", { file_path: file }, { callId: "repl_01large" });
    expect(repl.ok).toBe(true);
    expect(repl.result.file.numLines).toBe(2600);
    expect(repl.result.file.totalLines).toBe(2600);
    expect(repl.result.file.truncatedByTokenCap).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Grep includes totalFiles and totalLines for native pagination copy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-grep-totals-"));
  try {
    writeFileSync(join(dir, "a.ts"), "match\nmatch\nmatch\n");
    writeFileSync(join(dir, "b.ts"), "match\n");
    const filesMode = await run(dir, "Grep", { pattern: "match", path: dir, head_limit: 1 });
    expect(filesMode.ok).toBe(true);
    expect(filesMode.result.numFiles).toBe(1);
    expect(filesMode.result.totalFiles).toBe(2);

    const contentMode = await run(dir, "Grep", { pattern: "match", path: dir, output_mode: "content", head_limit: 2 });
    expect(contentMode.ok).toBe(true);
    expect(contentMode.result.numLines).toBe(2);
    expect(contentMode.result.totalLines).toBe(4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
