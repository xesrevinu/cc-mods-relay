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

/** Mods `tool.call` only accepts `{ result }` or `{ deny }`. Anything else is skipped and the builtin runs on Mini. */
function failResult(message) {
  return { deny: String(message) };
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

async function rpc($, frame, timeoutMs) {
  const ran = await $.process.run(helperArgv(), { stdin: payload(frame), timeoutMs });
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
    return ((await $.process.run(["printenv", "CC_MODS_SOCKET"], { timeoutMs: 2_000 })).stdout || "").trim();
  } catch {
    return "";
  }
}

function emit($, socketPath, event) {
  if (!socketPath) return;
  void $.http.fetch("http://adapter/events", {
    socketPath,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: [event] }),
  }).catch(() => {});
}

const pending = [];
let flushing = false;

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

  on("session.start", async ($, e, next) => {
    claudeSessionId = await sessionIdOf($, e);
    tuiUid = await tuiUidOf($);
    socket = await modSocket($);
    if (socket) {
      void $.http.fetch("http://adapter/hello", { socketPath: socket, method: "POST", body: "{}" }).catch(() => {});
    }
    try {
      const file = extraDirsFile();
      const raw = file && file !== String(ENDPOINT.helper)
        ? ((await $.process.run(["cat", file], { timeoutMs: 2_000 })).stdout || "").trim()
        : "";
      const parsed = raw ? JSON.parse(raw) : ENDPOINT.extraDirs;
      extraDirs = Array.isArray(parsed) ? parsed.filter((d) => typeof d === "string") : [];
    } catch {
      extraDirs = Array.isArray(ENDPOINT.extraDirs) ? ENDPOINT.extraDirs : [];
    }
    try {
      await rpcRetry($, { type: "hello" }, 8_000, 8);
      void (async () => {
        const listen = $.process.spawn({ argv: helperArgv(), input: payload({ type: "listen" }) });
        let buf = "";
        for await (const chunk of listen) {
          if (chunk.stream !== "stdout") continue;
          buf += chunk.text;
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line) continue;
            const frame = JSON.parse(line);
            if (frame.type === "notify" && frame.kind === "background" && frame.status === "exited") {
              if (frame.agentId) await flushPending($, frame.agentId);
              const text = taskNotification(frame);
              if (frame.agentId) {
                if (await deliverTaskText($, text, frame.agentId) === "retry") enqueue($, text, frame.agentId);
              } else if (mainBusy) {
                enqueue($, text);
              } else if (await deliverTaskText($, text) === "retry") {
                enqueue($, text);
              }
            }
            if (frame.type === "notify" && frame.kind === "monitor") {
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
    const parent = e.agentId ? spawnToolUse.get(e.agentId) : undefined;
    const tag = parent ? { parentToolUseId: parent } : {};
    const toolUseId = e.tool_use_id;
    const input = toolInput(e);
    emit($, socket, { type: "tool_started", toolUseId, tool: e.tool, input, ...tag });

    const finish = (isError, result) => {
      emit($, socket, { type: "tool_finished", toolUseId, isError, ...(result !== undefined ? { result } : {}), ...tag });
    };

    if (isLocalTool(e.tool)) {
      let frame;
      try {
        const liveSession = await sessionIdOf($, e);
        if (liveSession) claudeSessionId = liveSession;
        frame = await rpc($, {
          type: "call",
          id: toolUseId,
          callId: toolUseId,
          tool: e.tool,
          input,
          agentId: e.agentId,
          claudeSessionId,
          tuiUid,
        }, 600_000);
      } catch (error) {
        try { await rpc($, { type: "cancel", callId: toolUseId }, 5_000); } catch { /* already gone */ }
        const message = error && error.message ? String(error.message) : String(error);
        finish(true);
        return failResult(message);
      }
      if (!frame || !frame.ok) {
        const message = `${frame?.error?.code || "ERROR"}: ${frame?.error?.message || "Tool failed"}`;
        finish(true);
        return failResult(message);
      }
      if (frame.result === undefined) {
        finish(true);
        return failResult("empty tool result");
      }
      const result = objectResult(e.tool, frame.result, input);
      finish(false, result);
      return { result };
    }

    if (HYDRATE_TOOLS.has(e.tool) && typeof input.file_path === "string" && input.file_path) {
      try {
        const frame = await rpc($, { type: "call", id: toolUseId, callId: toolUseId, tool: "hydrate", input: { file_path: input.file_path } }, 60_000);
        if (frame.ok && frame.result && frame.result.base64 && frame.result.relative) {
          const dest = String(ENDPOINT.tuiRoot).replace(/\/$/, "") + "/" + frame.result.relative;
          const writer = String(ENDPOINT.helper).replace(/ws-client\.js$/, "write-file.js");
          await $.process.run(["bun", writer], { stdin: JSON.stringify({ path: dest, base64: frame.result.base64 }), timeoutMs: 30_000 });
        }
      } catch {
        /* native tool still runs; Mini may miss the file */
      }
    }

    const ran = await next(e);
    finish(ran.deny !== undefined || ran.isError === true, ran.deny !== undefined ? undefined : ran.result);
    return ran;
  }).catch(async ($, e, next) => {
    if (isLocalTool(e.tool) && !next.called) {
      try { await rpc($, { type: "cancel", callId: e.tool_use_id }, 5_000); } catch { /* already gone */ }
      return failResult("Tool call was cancelled");
    }
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    if (e.isAborted) {
      try {
        await rpc($, e.agentId ? { type: "cancel", agentId: e.agentId } : { type: "cancel" }, 5_000);
      } catch { /* already gone */ }
    }
    try {
      await flushPending($, e.agentId);
    } catch { /* ignore */ }
    if (!e.agentId) {
      mainBusy = false;
      const reason = e.reason === "answer" && hitMaxTokens ? "max_tokens" : e.reason;
      emit($, socket, { type: "turn_completed", reason, isAborted: !!e.isAborted });
      const u = e.usage;
      if (u && typeof u.input_tokens === "number" && typeof u.output_tokens === "number") {
        emit($, socket, {
          type: "usage",
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cachedReadTokens: u.cache_read_input_tokens,
          cachedWriteTokens: u.cache_creation_input_tokens,
        });
      }
      try { await rpc($, { type: "turn.complete", answer: e.answer || "", isAborted: !!e.isAborted }, 5_000); } catch { /* ignore */ }
    }
    return next(e);
  });
}
