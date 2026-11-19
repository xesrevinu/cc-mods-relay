const ENDPOINT = {"url":"","token":"","cwd":"","tuiRoot":"","helper":"","extraDirs":[]};

// Mods forbids passing `$` into a nested helper, and forbids reading a noun as a
// value. Always `$.noun.op(...)` at the call site, including top-level helpers.

const RESERVED = new Set(["tool", "tool_use_id", "agentId", "consent", "requestMeta"]);

const WORKSPACE_TOOLS = new Set(["Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit", "Bash", "PowerShell"]);
const DEFERRED_TOOLS = new Set(["Monitor", "EnterWorktree", "ExitWorktree", "SendFile", "SendUserFile"]);
const HYDRATE_TOOLS = new Set(["Artifact", "DesignSync"]);

function isLocalTool(tool) {
  return WORKSPACE_TOOLS.has(tool) || DEFERRED_TOOLS.has(tool);
}

/** Mods `tool.call` only accepts `{ result }` or `{ deny }`. Hook-authored `{ isError: true }` skips/unloads the hook. */
function failResult(message) {
  return { deny: String(message) };
}

/** User/transport/jail refusal — not a completed tool. Missing files must not go through here. */
function permissionDenied(code) {
  return (
    code === "CANCELLED" ||
    code === "UNAUTHORIZED" ||
    code === "CALL_ID_CONFLICT" ||
    code === "PATH_DENIED" ||
    code === "EXECUTOR_DISCONNECTED" ||
    code === "NO_INSTANCE" ||
    code === "NO_CONNECTION"
  );
}

/** Claude Code writes persisted oversized tool outputs on Mini under tool-results/. */
function isMiniArtifactPath(path) {
  if (typeof path !== "string" || !path) return false;
  const norm = path.replaceAll("\\", "/");
  if (/(^|\/)\.\.(\/|$)/.test(norm)) return false;
  return /\/\.claude\/projects\/[^/]+\/[^/]+\/tool-results(\/|$)/.test(norm);
}

/** Code Mode async REPL forbids `run_in_background: true` on inner Bash calls. */
function isReplInnerCall(id) {
  return typeof id === "string" && id.startsWith("repl_");
}

function rpcTimeoutMs(tool) {
  // Bash foreground max is 600s + 2s drain + direnv overhead; keep RPC timeout safely above it.
  if (tool === "Bash" || tool === "PowerShell") return 660_000;
  return 120_000;
}

function resultPath(input) {
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.path === "string") return input.path;
  if (typeof input.notebook_path === "string") return input.notebook_path;
  return "";
}

/**
 * Tool ran and failed. `{ deny }` would show as permission denied in the TUI.
 * Must not reuse objectResult (that wrapper is a successful fallback).
 */
function errorResult(tool, message, input) {
  const text = String(message || "Tool failed");
  const filePath = resultPath(input);
  if (tool === "Bash" || tool === "PowerShell") return { stdout: "", stderr: text, interrupted: false };
  if (tool === "NotebookEdit") {
    return {
      new_source: "",
      cell_type: "code",
      language: "python",
      edit_mode: typeof input.edit_mode === "string" && input.edit_mode ? input.edit_mode : "replace",
      error: text,
      notebook_path: filePath,
      original_file: "",
      updated_file: "",
    };
  }
  if (tool === "Grep") return { numFiles: 0, filenames: [], content: text };
  if (tool === "Glob") return { durationMs: 0, numFiles: 0, filenames: [], truncated: false };
  if (tool === "Read") {
    const lines = text.split("\n");
    return { type: "text", file: { filePath, content: text, numLines: lines.length, startLine: 1, totalLines: lines.length } };
  }
  if (tool === "Write") return { type: "update", filePath, content: text, structuredPatch: [], originalFile: null };
  if (tool === "Edit") {
    return { filePath, oldString: "", newString: text, originalFile: null, structuredPatch: [], userModified: false, replaceAll: input.replace_all === true };
  }
  if (tool === "EnterWorktree") return { worktreePath: "", message: text };
  if (tool === "ExitWorktree") {
    return { action: input.action === "remove" ? "remove" : "keep", originalCwd: "", worktreePath: "", message: text };
  }
  if (tool === "Monitor") return { taskId: "", timeoutMs: 0 };
  if (tool === "SendFile" || tool === "SendUserFile") return { filePath, bytes: 0 };
  return { stdout: "", stderr: text, interrupted: false };
}

/** Mods `{ result }` must match Claude Agent SDK ToolOutputSchemas. A string skips the hook and runs the builtin on the TUI host. */
function objectResult(tool, result, input) {
  if (result && typeof result === "object" && !Array.isArray(result)) return result;
  const text = typeof result === "string" ? result : result == null ? "" : JSON.stringify(result);
  const filePath =
    typeof input.file_path === "string" ? input.file_path
    : typeof input.path === "string" ? input.path
    : typeof input.notebook_path === "string" ? input.notebook_path
    : "";
  if (tool === "Read") {
    const lines = text.split("\n");
    return { type: "text", file: { filePath, content: text, numLines: lines.length, startLine: 1, totalLines: lines.length } };
  }
  if (tool === "Write") return { type: "create", filePath, content: text, structuredPatch: [], originalFile: null };
  if (tool === "Edit") {
    return { filePath, oldString: "", newString: text, originalFile: null, structuredPatch: [], userModified: false, replaceAll: false };
  }
  if (tool === "Bash" || tool === "PowerShell") return { stdout: text, stderr: "", interrupted: false };
  if (tool === "Grep") return { numFiles: 0, filenames: [] };
  if (tool === "Glob") return { durationMs: 0, numFiles: 0, filenames: [], truncated: false };
  if (tool === "NotebookEdit") {
    return { new_source: text, cell_type: "code", language: "python", edit_mode: "replace", notebook_path: filePath, original_file: "", updated_file: "" };
  }
  if (tool === "Monitor") return { taskId: "", timeoutMs: 0 };
  if (tool === "EnterWorktree") return { worktreePath: "", message: text };
  if (tool === "ExitWorktree") return { action: "keep", originalCwd: "", worktreePath: "", message: text };
  if (tool === "SendFile" || tool === "SendUserFile") return { filePath, bytes: 0 };
  return { stdout: text, stderr: "", interrupted: false };
}
let extraDirs = [];
let permissionSeq = 0;

function helperArgv() {
  return ["bun", ENDPOINT.helper];
}

function extraDirsFile() {
  return String(ENDPOINT.helper || "").replace(/hooks\/ws-client\.js$/, "extra-dirs.json");
}

function payload(frame) {
  return JSON.stringify({
    url: ENDPOINT.url,
    token: ENDPOINT.token,
    cwd: ENDPOINT.cwd,
    tuiRoot: ENDPOINT.tuiRoot,
    extraDirs,
    ...frame,
  });
}

async function awaitJson($, socketPath, path, requestId) {
  if (!socketPath) return null;
  for (;;) {
    try {
      const res = await $.http.fetch("http://adapter" + path + "?id=" + encodeURIComponent(requestId), { socketPath });
      if (res.status === 200) return JSON.parse(res.text);
    } catch {
      /* retry */
    }
    await new Promise((resolve) => $.clock.after(1_000, resolve));
  }
}

function toolInput(e) {
  const input = {};
  for (const [key, value] of Object.entries(e)) {
    if (!RESERVED.has(key)) input[key] = value;
  }
  return input;
}

function xmlText(value) {
  return String(value ?? "").replace(/[<>&]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[ch]));
}

function shellQuote(value) {
  return "'" + String(value ?? "").replace(/'/g, `'\\''`) + "'";
}

function waiterId(callId) {
  const raw = String(callId || "");
  if (!raw) return "";
  return raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

function waiterDonePath(id) {
  return "/tmp/cc-mods-wait/" + id + ".done";
}

function waiterOutPath(id) {
  return "/tmp/cc-mods-wait/" + id + ".out";
}

/** Mini builtin must own a pid so origin is task-notification, not a plugin prompt. */
function waiterScript(callId) {
  const id = waiterId(callId);
  const done = shellQuote(waiterDonePath(id));
  const out = shellQuote(waiterOutPath(id));
  return "mkdir -p /tmp/cc-mods-wait; while [ ! -f " + done + " ]; do sleep 0.2; done; cat " + out + " 2>/dev/null; IFS= read -r cc_mods_ex < " + done + " || [ -n \"$cc_mods_ex\" ] || cc_mods_ex=0; rm -f " + out + " " + done + "; exit \"$cc_mods_ex\"";
}

function waiterDescription(e) {
  if (typeof e.description === "string" && e.description) return e.description;
  if (e.tool_input && typeof e.tool_input.description === "string" && e.tool_input.description) return e.tool_input.description;
  const orig = typeof e.command === "string" ? e.command : (e.tool_input && typeof e.tool_input.command === "string" ? e.tool_input.command : "");
  return orig ? orig.replace(/\s+/g, " ").trim().slice(0, 120) : "";
}

function waiterEvent(e, script) {
  const desc = waiterDescription(e);
  const patched = { ...e, command: script, run_in_background: true, ...(desc ? { description: desc } : {}) };
  delete patched.timeout;
  if (e.tool_input && typeof e.tool_input === "object") {
    const nextInput = { ...e.tool_input, command: script, run_in_background: true, ...(desc ? { description: desc } : {}) };
    delete nextInput.timeout;
    patched.tool_input = nextInput;
  }
  return patched;
}

/**
 * Code Mode async REPL rejects `run_in_background: true`, but auto-backgrounds a
 * foreground Bash when its `timeout` elapses. Handing the waiter script a short
 * timeout lets Mini's builtin own the pid so completion is native `task-notification`
 * even when the main session is idle.
 */
function replWaiterEvent(e, script) {
  const desc = waiterDescription(e);
  const patched = { ...e, command: script, timeout: 500, ...(desc ? { description: desc } : {}) };
  delete patched.run_in_background;
  if (e.tool_input && typeof e.tool_input === "object") {
    const nextInput = { ...e.tool_input, command: script, timeout: 500, ...(desc ? { description: desc } : {}) };
    delete nextInput.run_in_background;
    patched.tool_input = nextInput;
  }
  return patched;
}

function exitStubEvent(e, script) {
  const patched = { ...e, command: script };
  delete patched.run_in_background;
  delete patched.timeout;
  if (e.tool_input && typeof e.tool_input === "object") {
    const nextInput = { ...e.tool_input, command: script };
    delete nextInput.run_in_background;
    delete nextInput.timeout;
    patched.tool_input = nextInput;
  }
  return patched;
}

async function writeTextFile($, path, text) {
  try {
    await $.fs.write(path, text);
    return;
  } catch {
    /* fallback to bash if $.fs.write is unavailable or text exceeds $.fs limit */
  }
  const w = await $.process.run(["/bin/bash", "-c", "mkdir -p /tmp/cc-mods-wait && cat > " + shellQuote(path)], {
    stdin: text,
    timeoutMs: 5_000,
  });
  if (w.exitCode !== 0) throw new Error("temp file write failed");
}

async function runExitStub($, e, next, callId, exitCode, stdoutText, stderrText) {
  const id = waiterId(callId) || String(Date.now());
  const outPath = "/tmp/cc-mods-wait/ex-" + id + ".out";
  const errPath = "/tmp/cc-mods-wait/ex-" + id + ".err";
  const parts = [];
  if (stdoutText) {
    const outBody = stderrText && !stdoutText.endsWith("\n") ? stdoutText + "\n" : stdoutText;
    await writeTextFile($, outPath, outBody);
    parts.push("cat " + shellQuote(outPath) + " 2>/dev/null; rm -f " + shellQuote(outPath));
  }
  if (stderrText) {
    await writeTextFile($, errPath, stderrText);
    parts.push("cat " + shellQuote(errPath) + " >&2 2>/dev/null; rm -f " + shellQuote(errPath));
  }
  parts.push("exit " + String(exitCode));
  return next(exitStubEvent(e, parts.join("; ")));
}

function isBackgroundResult(result) {
  return !!(result && typeof result === "object" && result.backgroundTaskId != null && String(result.backgroundTaskId));
}

async function writeWaiterFiles($, frame) {
  const id = waiterId(frame.callId);
  if (!id) return;
  const code = Number.isFinite(Number(frame.exitCode)) ? String(Number(frame.exitCode)) : "0";
  const text = typeof frame.output === "string" ? frame.output : "";
  await writeTextFile($, waiterOutPath(id), text);
  await writeTextFile($, waiterDonePath(id), code + "\n");
}

async function deliverBackground($, frame, busy) {
  if (frame.agentId) await flushPending($, frame.agentId);
  const text = taskNotification(frame);
  if (frame.agentId) {
    if (await deliverTaskText($, text, frame.agentId) === "retry") enqueue($, text, frame.agentId);
  } else if (busy) {
    enqueue($, text);
  } else if (await deliverTaskText($, text) === "retry") {
    enqueue($, text);
  }
}

async function miniHasPath($, path) {
  if (!path || typeof path !== "string") return false;
  try {
    let target = path;
    if (path === "~" || path.startsWith("~/")) {
      const home = await $.env.get("HOME");
      if (typeof home === "string" && home) target = home + path.slice(1);
    }
    if (target.startsWith("/")) {
      return (await $.fs.exists(target)) === true;
    }
  } catch {
    /* fall back to test -e */
  }
  try {
    const argv = path === "~" || path.startsWith("~/")
      ? ["/bin/sh", "-c", 'test -e "$HOME$1"', "_", path.slice(1)]
      : ["test", "-e", path];
    const ran = await $.process.run(argv, { timeoutMs: 2_000 });
    return ran.exitCode === 0;
  } catch {
    return false;
  }
}

function mergeBackgroundResult(client, waiter) {
  if (!waiter || typeof waiter !== "object" || !waiter.result || typeof waiter.result !== "object") return waiter;
  if (!client || typeof client !== "object") return waiter;
  const merged = { ...waiter.result };
  if (client.timedOutAfterMs !== undefined) {
    merged.timedOutAfterMs = client.timedOutAfterMs;
    if (typeof client.stdout === "string") merged.stdout = client.stdout;
    if (typeof client.stderr === "string") merged.stderr = client.stderr;
  } else if (typeof client.stderr === "string" && client.stderr && !merged.stderr) {
    merged.stderr = client.stderr;
  }
  if (typeof client.backgroundCwdHint === "string" && client.backgroundCwdHint) {
    merged.backgroundCwdHint = client.backgroundCwdHint;
  }
  return { ...waiter, result: merged };
}

function dropCallMappings(callId) {
  if (!callId) return;
  for (const [taskId, cid] of waiterTasks) {
    if (cid === callId) waiterTasks.delete(taskId);
  }
  for (const [taskId, cid] of replBgTasks) {
    if (cid === callId) replBgTasks.delete(taskId);
  }
  for (const [taskId, cid] of monitorTasks) {
    if (cid === callId) monitorTasks.delete(taskId);
  }
}

async function sessionIdOf($, e) {
  try {
    const value = await $.session.id();
    if (typeof value === "string" && value) return value;
  } catch {
    /* session namespace missing in this Claude Code build */
  }
  return typeof e?.sessionId === "string" ? e.sessionId : "";
}

async function tuiUidOf($) {
  try {
    return ((await $.process.run(["id", "-u"], { timeoutMs: 2_000 })).stdout || "").trim();
  } catch {
    return "";
  }
}

function after($, ms) {
  return new Promise((resolve) => $.clock.after(ms, resolve));
}

function shouldRetryDelivery(reason) {
  return (
    reason.includes("the session was stopped") ||
    reason.includes("removed from the queue")
  );
}

function agentGone(reason) {
  const r = String(reason).toLowerCase();
  return (
    r.includes("was not resumed") ||
    r.includes("was not messaged") ||
    r.includes("no live teammate") ||
    r.includes("no sendmessage tool")
  );
}

async function submitParent($, text) {
  try {
    const result = await $.prompt.submit({ text });
    const drop = result && result.drop ? String(result.drop) : "";
    if (shouldRetryDelivery(drop)) return "retry";
  } catch (error) {
    const reason = String(error && error.message ? error.message : error);
    if (shouldRetryDelivery(reason)) return "retry";
  }
  return "ok";
}

async function deliverTaskText($, text, agentId) {
  if (!text) return "ok";
  if (agentId) {
    let reason = "";
    try {
      const sent = await $.session.send({ to: { agentId }, text });
      if (sent && sent.isDelivered !== false) return "ok";
      reason = sent && sent.reason ? String(sent.reason) : "not delivered";
    } catch (error) {
      reason = String(error && error.message ? error.message : error);
    }
    if (agentGone(reason)) return submitParent($, text);
    return "retry";
  }
  return submitParent($, text);
}

function taskNotification(frame) {
  const code = Number(frame.exitCode);
  const status = code === 0 ? "completed" : "failed";
  const summary = status === "completed"
    ? `Command completed (exit code ${code})`
    : `Command failed with exit code ${code}`;
  const toolUseId = frame.callId || String(frame.pid ?? "");
  return [
    "<task-notification>",
    `<tool-use-id>${xmlText(toolUseId)}</tool-use-id>`,
    `<status>${status}</status>`,
    `<summary>${xmlText(summary)}</summary>`,
    ...(frame.outputFile ? [`<output-file>${xmlText(frame.outputFile)}</output-file>`] : []),
    "</task-notification>",
  ].join("\n");
}

function monitorNotification(frame) {
  const toolUseId = frame.callId || "";
  if (frame.status === "event") {
    return [
      "<monitor-event>",
      `<tool-use-id>${xmlText(toolUseId)}</tool-use-id>`,
      `<summary>${xmlText(frame.line)}</summary>`,
      "</monitor-event>",
    ].join("\n");
  }
  const expired = frame.status === "expired";
  const code = Number(frame.exitCode);
  const status = expired ? "failed" : code === 0 ? "completed" : "failed";
  const summary = expired
    ? `Monitor expired after ${Number(frame.timeoutMs) || 0}ms with no further events.`
    : `Monitor ended (exit code ${Number.isFinite(code) ? code : "?"})`;
  return [
    "<task-notification>",
    `<tool-use-id>${xmlText(toolUseId)}</tool-use-id>`,
    `<status>${status}</status>`,
    `<summary>${xmlText(summary)}</summary>`,
    "</task-notification>",
  ].join("\n");
}

let rpcSocket = "";
let rpcSeq = 0;

async function rpc($, frame, timeoutMs) {
  const budget = timeoutMs || 60_000;
  const deadline = Date.now() + budget;
  if (rpcSocket && frame.type !== "hello") {
    try {
      let res = await $.http.fetch("http://tools/rpc", {
        socketPath: rpcSocket,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload({ ...frame, sliceMs: Math.min(20_000, budget) }),
      });
      if (res.status === 200) {
        let parsed = JSON.parse(res.text);
        while (parsed && parsed.pending === true) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error("RPC timed out");
          res = await $.http.fetch("http://tools/wait", {
            socketPath: rpcSocket,
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ callId: parsed.callId || frame.callId || frame.id, sliceMs: Math.min(20_000, remaining) }),
          });
          if (res.status === 502) break;
          if (res.status !== 200) throw new Error("wait HTTP " + res.status);
          parsed = JSON.parse(res.text);
        }
        if (res.status === 200) return parsed;
      }
      // On 502/503 (listener WS dropped or reconnecting), fall through to one-shot
      // helper; Client tool-executor dedupes by callId so retrying the call is safe.
    } catch (error) {
      if (error && String(error.message) === "RPC timed out") throw error;
    }
  }
  const remaining = Math.max(5_000, deadline - Date.now());
  const ran = await $.process.run(helperArgv(), { stdin: payload(frame), timeoutMs: remaining });
  const text = (ran.stdout || "").trim();
  if (!text) throw new Error(ran.stderr || `helper exit ${ran.exitCode}`);
  const lines = text.split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

async function rpcRetry($, frame, timeoutMs, attempts) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await rpc($, frame, timeoutMs);
    } catch (error) {
      last = error;
      await new Promise((resolve) => $.clock.after(400, resolve));
    }
  }
  throw last || new Error("executor unavailable");
}

async function modSocket($) {
  try {
    const fromEnv = await $.env.get("CC_MODS_SOCKET");
    if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  } catch {
    /* fall back to printenv */
  }
  try {
    return ((await $.process.run(["printenv", "CC_MODS_SOCKET"], { timeoutMs: 2_000 })).stdout || "").trim();
  } catch {
    return "";
  }
}

async function readExtraDirs($, file) {
  if (!file || file === String(ENDPOINT.helper)) return "";
  try {
    const text = await $.fs.read(file);
    if (typeof text === "string") return text.trim();
  } catch {
    /* fall back to cat */
  }
  try {
    return ((await $.process.run(["cat", file], { timeoutMs: 2_000 })).stdout || "").trim();
  } catch {
    return "";
  }
}

const emitQueue = [];
let emitBusy = false;
let emitScheduled = false;

function coalesceEvents(items) {
  const out = [];
  for (const ev of items) {
    const prev = out[out.length - 1];
    if (
      prev &&
      ev &&
      prev.type === "chunk" &&
      ev.type === "chunk" &&
      prev.kind === ev.kind &&
      prev.parentToolUseId === ev.parentToolUseId &&
      typeof prev.text === "string" &&
      typeof ev.text === "string"
    ) {
      prev.text += ev.text;
    } else {
      out.push(ev && typeof ev === "object" ? { ...ev } : ev);
    }
  }
  return out;
}

async function pumpEvents($, socketPath) {
  if (!socketPath || emitBusy) return;
  emitBusy = true;
  try {
    while (emitQueue.length) {
      const batch = coalesceEvents(emitQueue.splice(0));
      try {
        await $.http.fetch("http://adapter/events", {
          socketPath,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ events: batch }),
        });
      } catch {
        /* adapter gone */
      }
    }
  } finally {
    emitBusy = false;
  }
}

let activeSessionId = "";

function emit($, socketPath, event) {
  if (!socketPath || !event) return;
  const stamped = activeSessionId && !event.sessionId ? { ...event, sessionId: activeSessionId } : event;
  emitQueue.push(stamped);
  if (stamped.type === "chunk") {
    if (!emitBusy && !emitScheduled) {
      emitScheduled = true;
      void after($, 16).then(() => {
        emitScheduled = false;
        void pumpEvents($, socketPath);
      });
    }
    return;
  }
  void pumpEvents($, socketPath);
}

const pending = [];
const waiters = new Set();
const waiterActive = new Set();
const skippedNotify = new Map();
const bgDelivered = new Set();
const stoppedCalls = new Set();
const waiterTasks = new Map();
const replBgTasks = new Map();
const monitorTasks = new Map();

function rememberStopped(callId) {
  if (!callId) return;
  stoppedCalls.add(callId);
  if (stoppedCalls.size > 200) stoppedCalls.delete(stoppedCalls.values().next().value);
}
let listenGen = 0;
let flushing = false;
const mainInflight = new Set();
const replStack = [];
let sawReplThisTurn = false;
let replDispatchedThisTurn = false;
let completeGen = 0;
let pendingComplete = null;
let currentTurnId = "";

function isReplDispatch(result) {
  if (result == null) return false;
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return /\(dispatched\b|dispatched #\d+/i.test(text);
}

function resetPendingComplete() {
  completeGen++;
  pendingComplete = null;
  sawReplThisTurn = false;
  replDispatchedThisTurn = false;
  mainInflight.clear();
}

function flushTurnComplete($, sock) {
  const payload = pendingComplete;
  pendingComplete = null;
  if (!payload) return;
  sawReplThisTurn = false;
  replDispatchedThisTurn = false;
  emit($, sock, {
    type: "turn_completed",
    reason: payload.reason,
    isAborted: payload.isAborted,
    ...(payload.turnId ? { turnId: payload.turnId } : {}),
  });
  const u = payload.usage;
  if (u && typeof u.input_tokens === "number" && typeof u.output_tokens === "number") {
    emit($, sock, {
      type: "usage",
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cachedReadTokens: u.cache_read_input_tokens,
      cachedWriteTokens: u.cache_creation_input_tokens,
    });
  }
  void rpc($, { type: "turn.complete", answer: payload.answer || "", isAborted: payload.isAborted }, 5_000).catch(() => {});
}

function settleTurnComplete($, sock) {
  const gen = ++completeGen;
  const payload = pendingComplete;
  if (!payload) return;
  if (!replDispatchedThisTurn && mainInflight.size === 0 && replStack.length === 0) {
    flushTurnComplete($, sock);
    return;
  }
  void after($, 0).then(async () => {
    let idle = 0;
    let started = false;
    let waited = 0;
    while (gen === completeGen && pendingComplete === payload) {
      if (mainInflight.size > 0) {
        started = true;
        idle = 0;
        await after($, 100);
        waited += 100;
        if (waited >= 15_000) {
          if (gen === completeGen && pendingComplete === payload) flushTurnComplete($, sock);
          return;
        }
        continue;
      }
      idle += 100;
      waited += 100;
      const need = started ? (sawReplThisTurn ? 8_000 : 400) : 8_000;
      if (idle >= need || waited >= 15_000) {
        if (gen === completeGen && pendingComplete === payload) flushTurnComplete($, sock);
        return;
      }
      await after($, 100);
    }
  });
}

function enqueue($, text, agentId) {
  if (!text) return;
  if (pending.length >= 100) {
    const idx = pending.findIndex((item) => !String(item.text).includes("<task-notification>"));
    if (idx >= 0) pending.splice(idx, 1);
    else if (!String(text).includes("<task-notification>")) return;
    else pending.shift();
  }
  pending.push({ text, agentId });
  kickFlush($);
}

function kickFlush($) {
  if (flushing || pending.length === 0) return;
  flushing = true;
  void after($, 1_500).then(async () => {
    flushing = false;
    try {
      await flushPending($);
    } catch { /* ignore */ }
    if (pending.length) kickFlush($);
  });
}

async function flushPending($, agentId) {
  const keep = [];
  const items = pending.splice(0);
  for (const item of items) {
    if (agentId && item.agentId !== agentId) {
      keep.push(item);
      continue;
    }
    if (await deliverTaskText($, item.text, item.agentId) === "retry") keep.push(item);
  }
  for (const item of keep) pending.push(item);
  if (pending.length) kickFlush($);
}

function drainMainBlock() {
  const keep = [];
  const texts = [];
  for (const item of pending) {
    if (item.agentId) keep.push(item);
    else texts.push(item.text);
  }
  pending.length = 0;
  for (const item of keep) pending.push(item);
  return texts.join("\n");
}

export function register(on) {
  let mainBusy = false;
  let socket = "";
  let hitMaxTokens = false;
  let claudeSessionId = "";
  let tuiUid = "";
  const spawnToolUse = new Map();

  function pushRepl(id) {
    if (typeof id !== "string" || !id) return;
    sawReplThisTurn = true;
    if (replStack[replStack.length - 1] !== id) replStack.push(id);
  }

  on("session.start", async ($, e, next) => {
    resetPendingComplete();
    emitQueue.length = 0;
    emitScheduled = false;
    waiters.clear();
    waiterActive.clear();
    skippedNotify.clear();
    bgDelivered.clear();
    stoppedCalls.clear();
    waiterTasks.clear();
    replBgTasks.clear();
    monitorTasks.clear();
    spawnToolUse.clear();
    replStack.length = 0;
    const myListenGen = ++listenGen;
    claudeSessionId = await sessionIdOf($, e);
    activeSessionId = claudeSessionId;
    tuiUid = await tuiUidOf($);
    socket = await modSocket($);
    if (socket) {
      void $.http.fetch("http://adapter/hello", { socketPath: socket, method: "POST", body: "{}" }).catch(() => {});
    }
    try {
      const file = extraDirsFile();
      const raw = await readExtraDirs($, file);
      const parsed = raw ? JSON.parse(raw) : ENDPOINT.extraDirs;
      extraDirs = Array.isArray(parsed) ? parsed.filter((d) => typeof d === "string") : [];
    } catch {
      extraDirs = Array.isArray(ENDPOINT.extraDirs) ? ENDPOINT.extraDirs : [];
    }
    try {
      await rpcRetry($, { type: "hello" }, 8_000, 8);
      void (async () => {
        while (myListenGen === listenGen) {
          const nextSock = "/tmp/cc-mods-rpc-" + String(Date.now()).slice(-7) + "-" + String(++rpcSeq) + ".sock";
          rpcSocket = nextSock;
          try {
            const listen = $.process.spawn({ argv: helperArgv(), input: payload({ type: "listen", rpcSocket: nextSock }) });
            let buf = "";
            for await (const chunk of listen) {
              if (myListenGen !== listenGen) break;
              if (chunk.stream !== "stdout") continue;
              buf += chunk.text;
              let nl;
              while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                if (!line) continue;
                let frame;
                try { frame = JSON.parse(line); } catch { continue; }
                if (frame.type === "notify" && frame.kind === "background" && frame.status === "exited") {
                  const callId = String(frame.callId || "");
                  dropCallMappings(callId);
                  const stoppedByUser = !!(callId && stoppedCalls.has(callId));
                  const suppressed = frame.interrupted === true || stoppedByUser;
                  if (callId) stoppedCalls.delete(callId);
                  if (callId && waiterActive.has(callId)) {
                    waiterActive.delete(callId);
                    if (!stoppedByUser) {
                      try { await writeWaiterFiles($, frame); } catch { /* waiter may already be gone */ }
                    }
                    continue;
                  }
                  if (callId && waiters.has(callId)) {
                    waiters.delete(callId);
                    if (!suppressed) skippedNotify.set(callId, frame);
                    if (!stoppedByUser) {
                      try { await writeWaiterFiles($, frame); } catch { /* waiter may still be starting */ }
                    }
                    continue;
                  }
                  if (suppressed) continue;
                  if (callId) {
                    bgDelivered.add(callId);
                    if (bgDelivered.size > 200) bgDelivered.delete(bgDelivered.values().next().value);
                  }
                  await deliverBackground($, frame, mainBusy);
                }
                if (frame.type === "notify" && frame.kind === "monitor") {
                  const callId = String(frame.callId || "");
                  if (frame.status === "exited" || frame.status === "expired") dropCallMappings(callId);
                  if (frame.interrupted === true || (callId && stoppedCalls.has(callId))) {
                    if (callId && (frame.status === "exited" || frame.status === "expired")) stoppedCalls.delete(callId);
                    continue;
                  }
                  if (frame.agentId) await flushPending($, frame.agentId);
                  const text = monitorNotification(frame);
                  if (frame.agentId) {
                    if (await deliverTaskText($, text, frame.agentId) === "retry") enqueue($, text, frame.agentId);
                  } else if (await deliverTaskText($, text) === "retry") {
                    enqueue($, text);
                  }
                }
              }
            }
          } catch {
            /* listener exited; respawn below */
          }
          if (rpcSocket === nextSock) rpcSocket = "";
          if (myListenGen !== listenGen) break;
          await after($, 500);
        }
      })();
    } catch (error) {
      const message = error && error.message ? String(error.message) : String(error);
      emit($, socket, { type: "plugin_error", message });
    }
    return next(e);
  });

  on("turn.start", async ($, e, next) => {
    try {
      await flushPending($, e.agentId);
    } catch { /* ignore */ }
    if (!e.agentId) {
      mainBusy = true;
      hitMaxTokens = false;
      resetPendingComplete();
      replStack.length = 0;
      currentTurnId = typeof e.turnId === "string" ? e.turnId : "";
      emit($, socket, { type: "turn_started", turnId: e.turnId });
    }
    return next(e);
  });

  on("turn.step", async function* ($, e, next) {
    for await (const chunk of next(e)) {
      if (chunk.kind === "stop" && !e.agentId && chunk.stopReason === "max_tokens") hitMaxTokens = true;
      if (chunk.kind === "text" || chunk.kind === "thinking") {
        const parent = e.agentId ? spawnToolUse.get(e.agentId) : undefined;
        if (!e.agentId || parent) {
          emit($, socket, {
            type: "chunk",
            kind: chunk.kind,
            text: chunk.text,
            ...(parent ? { parentToolUseId: parent } : {}),
          });
        }
      }
      yield chunk;
    }
  });

  on("agent.spawn", async ($, e, next) => {
    const spawned = await next(e);
    if (spawned.agentId && e.tool_use_id) spawnToolUse.set(spawned.agentId, e.tool_use_id);
    return spawned;
  });

  on("classic.Stop", ($, e, next) => {
    const text = drainMainBlock();
    if (!text) return next(e);
    return { block: text };
  });

  on("classic.PermissionRequest", async ($, e, next) => {
    const input = e.tool_input && typeof e.tool_input === "object" ? e.tool_input : {};
    if (e.tool_name === "AskUserQuestion" && Array.isArray(input.questions)) {
      const requestId = "q" + String(++permissionSeq);
      emit($, socket, { type: "ask_question", requestId, questions: input.questions, toolUseId: e.tool_use_id });
      const body = await awaitJson($, socket, "/question", requestId);
      const answers = body && body.answers && typeof body.answers === "object" ? body.answers : null;
      if (!answers) return { decision: { behavior: "deny", message: "The user declined to answer." } };
      return { decision: { behavior: "allow", updatedInput: { ...input, answers } } };
    }
    const requestId = String(Date.now()) + "-" + String(++permissionSeq);
    emit($, socket, {
      type: "permission_request",
      requestId,
      tool: e.tool_name,
      input,
      toolUseId: e.tool_use_id,
      suggestions: e.permission_suggestions,
    });
    const body = await awaitJson($, socket, "/permission", requestId);
    const decision = body && body.decision;
    if (decision === "allow_once") return { decision: { behavior: "allow" } };
    if (decision === "allow_with_updates") {
      return {
        decision: {
          behavior: "allow",
          ...(Array.isArray(e.permission_suggestions) ? { updatedPermissions: e.permission_suggestions } : {}),
        },
      };
    }
    return { decision: { behavior: "deny", message: "Denied by the ACP client" } };
  });

  on("tool.call", async ($, e, next) => {
    const nested = e.tool !== "REPL" && replStack.length ? replStack[replStack.length - 1] : undefined;
    const parent = e.agentId ? spawnToolUse.get(e.agentId) : nested;
    const tag = parent ? { parentToolUseId: parent } : {};
    const toolUseId = e.tool_use_id;
    if (!e.agentId && typeof toolUseId === "string" && toolUseId) mainInflight.add(toolUseId);
    const input = toolInput(e);
    emit($, socket, { type: "tool_started", toolUseId, tool: e.tool, input, ...tag });

    const finish = (isError, result, error) => {
      emit($, socket, {
        type: "tool_finished",
        toolUseId,
        isError,
        ...(result !== undefined ? { result } : {}),
        ...(isError && error ? { error: String(error) } : {}),
        ...tag,
      });
    };

    if (e.tool === "REPL") pushRepl(toolUseId);
    try {
    if (isLocalTool(e.tool)) {
      let frame;
      if (e.tool === "Bash" && input.run_in_background === true && typeof toolUseId === "string" && toolUseId && !isReplInnerCall(toolUseId)) {
        waiters.add(toolUseId);
      }
      try {
        if (!claudeSessionId) {
          const liveSession = await sessionIdOf($, e);
          if (liveSession) {
            claudeSessionId = liveSession;
            activeSessionId = liveSession;
          }
        }
        frame = await rpc($, {
          type: "call",
          id: toolUseId,
          callId: toolUseId,
          tool: e.tool,
          input,
          agentId: e.agentId,
          claudeSessionId,
          tuiUid,
        }, rpcTimeoutMs(e.tool));
      } catch (error) {
        if (typeof toolUseId === "string" && toolUseId) waiters.delete(toolUseId);
        try { await rpc($, { type: "cancel", callId: toolUseId }, 5_000); } catch { /* already gone */ }
        const message = error && error.message ? String(error.message) : String(error);
        finish(true, undefined, message);
        return failResult(message);
      }
      if (!frame || !frame.ok) {
        if (typeof toolUseId === "string" && toolUseId) waiters.delete(toolUseId);
        const code = frame && frame.error && frame.error.code ? String(frame.error.code) : "ERROR";
        const message = frame && frame.error && frame.error.message ? String(frame.error.message) : "Tool failed";
        if (permissionDenied(code)) {
          finish(true, undefined, `${code}: ${message}`);
          return failResult(`${code}: ${message}`);
        }
        // Mac already confirmed ENOENT. Let Mini's builtin Read set core isError,
        // unless Mini still has a stale file at that path — except Mini-owned
        // Claude runtime artifacts (`~/.claude/projects/.../tool-results/...`),
        // which only exist on Mini and must fall through to Mini's builtin.
        if (e.tool === "Read" && /File does not exist:/i.test(message)) {
          const path = typeof input.file_path === "string" ? input.file_path : "";
          if (isMiniArtifactPath(path) || !(await miniHasPath($, path))) {
            const ran = await next(e);
            finish(ran.deny !== undefined || ran.isError === true, ran.deny !== undefined ? undefined : ran.result, message);
            return ran;
          }
        }
        if (e.tool === "Grep" && /No such file or directory|File does not exist/i.test(message)) {
          const path = typeof input.path === "string" ? input.path : "";
          if (isMiniArtifactPath(path) && (await miniHasPath($, path))) {
            const ran = await next(e);
            finish(ran.deny !== undefined || ran.isError === true, ran.deny !== undefined ? undefined : ran.result, ran.deny);
            return ran;
          }
        }
        const result = errorResult(e.tool, message, input);
        finish(true, result, message);
        return { result };
      }
      if (frame.result === undefined) {
        if (typeof toolUseId === "string" && toolUseId) waiters.delete(toolUseId);
        const result = errorResult(e.tool, "empty tool result", input);
        finish(true, result, "empty tool result");
        return { result };
      }
      if (
        e.tool === "Bash" &&
        isBackgroundResult(frame.result) &&
        typeof toolUseId === "string" &&
        toolUseId &&
        !bgDelivered.has(toolUseId)
      ) {
        const isRepl = isReplInnerCall(toolUseId);
        const alreadyExited = skippedNotify.has(toolUseId);
        if (!alreadyExited) waiters.add(toolUseId);
        try {
          const ran = isRepl
            ? await next(replWaiterEvent(e, waiterScript(toolUseId)))
            : await next(waiterEvent(e, waiterScript(toolUseId)));
          if (ran && ran.deny === undefined) {
            const exitedDuringStart = alreadyExited || skippedNotify.has(toolUseId);
            if (ran.isError !== true && (!isRepl || isBackgroundResult(ran.result))) {
              skippedNotify.delete(toolUseId);
              waiters.delete(toolUseId);
              const merged = mergeBackgroundResult(frame.result, ran);
              const miniId = merged.result && merged.result.backgroundTaskId != null ? String(merged.result.backgroundTaskId) : "";
              if (!exitedDuringStart) {
                waiterActive.add(toolUseId);
                if (miniId) waiterTasks.set(miniId, toolUseId);
              }
              if (miniId) {
                try { await rpc($, { type: "aliasTask", callId: toolUseId, taskId: miniId }, 2_000); } catch { /* best-effort */ }
              }
              finish(merged.isError === true, merged.result, merged.deny);
              return merged;
            }
            // Waiter completed before its short REPL timeout because Mac job already finished
            // (including non-zero exit codes).
            if (isRepl && exitedDuringStart && !isBackgroundResult(ran.result)) {
              skippedNotify.delete(toolUseId);
              waiters.delete(toolUseId);
              finish(ran.isError === true, ran.result, ran.deny);
              return ran;
            }
          }
        } catch { /* fall back to plugin prompt / replBgTasks */ }
        waiters.delete(toolUseId);
        if (isRepl) {
          replBgTasks.set(String(frame.result.backgroundTaskId), toolUseId);
        }
        const skipped = skippedNotify.get(toolUseId);
        if (skipped) {
          skippedNotify.delete(toolUseId);
          try { await deliverBackground($, skipped, mainBusy); } catch { /* retry timer */ }
        }
      } else if (typeof toolUseId === "string" && toolUseId) {
        if (e.tool === "Bash" && isBackgroundResult(frame.result) && isReplInnerCall(toolUseId)) {
          replBgTasks.set(String(frame.result.backgroundTaskId), toolUseId);
        }
        waiters.delete(toolUseId);
        waiterActive.delete(toolUseId);
        skippedNotify.delete(toolUseId);
        bgDelivered.delete(toolUseId);
      }
      if (
        e.tool === "Bash" &&
        !isBackgroundResult(frame.result) &&
        frame.result &&
        typeof frame.result === "object" &&
        frame.result.interrupted !== true &&
        typeof frame.exitCode === "number" &&
        Number.isInteger(frame.exitCode) &&
        frame.exitCode > 0 &&
        frame.exitCode <= 255
      ) {
        try {
          const outText = typeof frame.result.stdout === "string" ? frame.result.stdout : "";
          const errText = typeof frame.rawStderr === "string"
            ? frame.rawStderr
            : typeof frame.result.stderr === "string"
              ? frame.result.stderr
              : "";
          const ran = await runExitStub($, e, next, toolUseId, frame.exitCode, outText, errText);
          if (ran && ran.deny === undefined) {
            finish(ran.isError === true, ran.result, ran.deny);
            return ran;
          }
        } catch { /* fall back to object result */ }
      }
      if (e.tool === "Monitor" && frame.result && typeof frame.result === "object" && frame.result.taskId && typeof toolUseId === "string" && toolUseId) {
        monitorTasks.set(String(frame.result.taskId), toolUseId);
      }
      const result = objectResult(e.tool, frame.result, input);
      finish(false, result);
      return { result };
    }

    if (e.tool === "TaskStop") {
      const taskId = typeof input.task_id === "string" && input.task_id
        ? input.task_id
        : typeof input.shell_id === "string"
          ? input.shell_id
          : "";
      if (taskId && waiterTasks.has(taskId)) {
        const callId = waiterTasks.get(taskId);
        waiterTasks.delete(taskId);
        waiterActive.delete(callId);
        waiters.delete(callId);
        rememberStopped(callId);
        try { await rpc($, { type: "cancel", callId }, 5_000); } catch { /* already exited */ }
        const ran = await next(e);
        finish(ran.deny !== undefined || ran.isError === true, ran.deny !== undefined ? undefined : ran.result, ran.deny);
        return ran;
      }
      if (taskId && replBgTasks.has(taskId)) {
        const callId = replBgTasks.get(taskId);
        replBgTasks.delete(taskId);
        rememberStopped(callId);
        try { await rpc($, { type: "cancel", callId }, 5_000); } catch { /* already exited */ }
        const result = { message: "Stopped task " + taskId, task_id: taskId, task_type: "local_bash", command: "" };
        finish(false, result);
        return { result };
      }
      if (taskId && monitorTasks.has(taskId)) {
        const callId = monitorTasks.get(taskId);
        monitorTasks.delete(taskId);
        rememberStopped(callId);
        try { await rpc($, { type: "cancel", callId }, 5_000); } catch { /* already exited */ }
        const result = { message: "Stopped monitor task " + taskId, task_id: taskId, task_type: "monitor", command: "" };
        finish(false, result);
        return { result };
      }
    }

    if (HYDRATE_TOOLS.has(e.tool) && typeof input.file_path === "string" && input.file_path) {
      try {
        const frame = await rpc($, { type: "call", id: toolUseId, callId: toolUseId, tool: "hydrate", input: { file_path: input.file_path } }, 60_000);
        if (!frame || !frame.ok) {
          const code = frame && frame.error && frame.error.code ? String(frame.error.code) : "ERROR";
          const message = frame && frame.error && frame.error.message ? String(frame.error.message) : "Hydrate failed";
          const detail = permissionDenied(code) ? `${code}: ${message}` : message;
          finish(true, undefined, detail);
          return failResult(detail);
        }
        if (frame.result && frame.result.base64 && frame.result.relative) {
          const dest = String(ENDPOINT.tuiRoot).replace(/\/$/, "") + "/" + frame.result.relative;
          const writer = String(ENDPOINT.helper).replace(/ws-client\.js$/, "write-file.js");
          const wrote = await $.process.run(["bun", writer], { stdin: JSON.stringify({ path: dest, base64: frame.result.base64 }), timeoutMs: 30_000 });
          if (wrote.exitCode !== 0) {
            const detail = (wrote.stderr || wrote.stdout || `hydrate write failed (${wrote.exitCode})`).trim();
            finish(true, undefined, detail);
            return failResult(detail);
          }
        }
      } catch (error) {
        const detail = error && error.message ? String(error.message) : String(error);
        finish(true, undefined, detail);
        return failResult(detail);
      }
    }

    const ran = await next(e);
    if (e.tool === "REPL" && ran && ran.deny === undefined && ran.isError !== true && isReplDispatch(ran.result)) {
      replDispatchedThisTurn = true;
    }
    finish(
      ran.deny !== undefined || ran.isError === true,
      ran.deny !== undefined ? undefined : ran.result,
      ran.deny,
    );
    return ran;
    } finally {
      if (!e.agentId && typeof toolUseId === "string" && toolUseId) mainInflight.delete(toolUseId);
      if (e.tool === "REPL" && replStack.length && replStack[replStack.length - 1] === toolUseId) {
        replStack.pop();
      }
    }
  }).catch(async ($, e, next) => {
    const toolUseId = e.tool_use_id;
    const nested = e.tool !== "REPL" && replStack.length ? replStack[replStack.length - 1] : undefined;
    const parent = e.agentId ? spawnToolUse.get(e.agentId) : nested;
    if (!e.agentId && typeof toolUseId === "string" && toolUseId) mainInflight.delete(toolUseId);
    if (e.tool === "REPL" && replStack.length && replStack[replStack.length - 1] === toolUseId) {
      replStack.pop();
    }
    if (typeof toolUseId === "string" && toolUseId) {
      waiters.delete(toolUseId);
      waiterActive.delete(toolUseId);
      skippedNotify.delete(toolUseId);
      emit($, socket, {
        type: "tool_finished",
        toolUseId,
        isError: true,
        error: "Tool call was cancelled",
        ...(parent ? { parentToolUseId: parent } : {}),
      });
    }
    if (isLocalTool(e.tool) && !next.called) {
      try { await rpc($, { type: "cancel", callId: toolUseId }, 5_000); } catch { /* already gone */ }
      return failResult("Tool call was cancelled");
    }
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    if (e.isAborted) {
      // Turn abort stops in-flight foreground tools; background Bash/Monitor keep running.
      try {
        await rpc($, e.agentId ? { type: "cancel", agentId: e.agentId, scope: "turn" } : { type: "cancel", scope: "turn" }, 5_000);
      } catch { /* already gone */ }
    }
    try {
      await flushPending($, e.agentId);
    } catch { /* ignore */ }
    if (!e.agentId) {
      mainBusy = false;
      const reason = e.reason === "answer" && hitMaxTokens ? "max_tokens" : e.reason;
      pendingComplete = {
        reason,
        isAborted: !!e.isAborted,
        answer: e.answer || "",
        usage: e.usage,
        turnId: typeof e.turnId === "string" && e.turnId ? e.turnId : currentTurnId,
      };
      if (e.isAborted) flushTurnComplete($, socket);
      else settleTurnComplete($, socket);
    }
    return next(e);
  });

  on("session.end", async ($, e, next) => {
    listenGen++;
    rpcSocket = "";
    resetPendingComplete();
    waiters.clear();
    waiterActive.clear();
    skippedNotify.clear();
    waiterTasks.clear();
    replBgTasks.clear();
    monitorTasks.clear();
    try {
      await rpc($, { type: "cancel" }, 2_000);
    } catch { /* already gone */ }
    return next(e);
  });
}
