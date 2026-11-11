const ENDPOINT = {"url":"","token":"","cwd":"","tuiRoot":"","helper":"","extraDirs":[]};

// Mods forbids passing `$` into a nested helper. Keep `$.noun.op(...)` in the
// hook body, or in a function declared at the top of this file.

const RESERVED = new Set(["tool", "tool_use_id", "agentId", "consent", "requestMeta"]);

const WORKSPACE_TOOLS = new Set(["Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit", "Bash", "PowerShell"]);
const HOST_WRONG_TOOLS = new Set(["LSP", "Monitor", "EnterWorktree", "ExitWorktree", "SendFile", "SendUserFile"]);
const HYDRATE_TOOLS = new Set(["Artifact", "DesignSync"]);
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

export function register(on) {
  const pending = [];
  let mainBusy = false;
  let socket = "";
  let hitMaxTokens = false;
  const spawnToolUse = new Map();

  function drainPending() {
    if (!pending.length) return "";
    const text = pending.join("\n");
    pending.length = 0;
    return text;
  }

  on("session.start", async ($, e, next) => {
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
              pending.push(taskNotification(frame));
              if (!mainBusy) {
                const text = drainPending();
                if (text) await $.prompt.submit({ text });
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

  on("turn.start", ($, e, next) => {
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
    const text = drainPending();
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
    if (e.agentId && !parent) return next(e);
    const tag = parent ? { parentToolUseId: parent } : {};
    const toolUseId = e.tool_use_id;
    const input = toolInput(e);
    emit($, socket, { type: "tool_started", toolUseId, tool: e.tool, input, ...tag });

    const finish = (isError, result) => {
      emit($, socket, { type: "tool_finished", toolUseId, isError, ...(result !== undefined ? { result } : {}), ...tag });
    };

    if (HOST_WRONG_TOOLS.has(e.tool)) {
      finish(true);
      return { deny: "This tool would run on the TUI host, not the client workspace." };
    }

    if (WORKSPACE_TOOLS.has(e.tool)) {
      let frame;
      try {
        frame = await rpc($, { type: "call", id: toolUseId, callId: toolUseId, tool: e.tool, input }, 600_000);
      } catch (error) {
        try { await rpc($, { type: "cancel", callId: toolUseId }, 5_000); } catch { /* already gone */ }
        const message = error && error.message ? String(error.message) : String(error);
        finish(true, message);
        return { isError: true, result: message, text: message };
      }
      if (!frame.ok) {
        const message = `${frame.error?.code || "ERROR"}: ${frame.error?.message || "Tool failed"}`;
        finish(true, message);
        if (frame.error?.code === "UNSUPPORTED_TOOL") return { deny: message };
        return { isError: true, result: message, text: message };
      }
      finish(false, frame.result);
      return { result: frame.result };
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
    if (WORKSPACE_TOOLS.has(e.tool)) {
      try { await rpc($, { type: "cancel", callId: e.tool_use_id }, 5_000); } catch { /* already gone */ }
      return { isError: true, result: "Tool call was cancelled", text: "Tool call was cancelled" };
    }
    if (HOST_WRONG_TOOLS.has(e.tool)) {
      return { deny: "This tool would run on the TUI host, not the client workspace." };
    }
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    if (!e.agentId) {
      mainBusy = false;
      try {
        const text = drainPending();
        if (text) await $.prompt.submit({ text });
      } catch { /* ignore */ }
      const reason = e.reason === "answer" && hitMaxTokens ? "max_tokens" : e.reason;
      if (e.isAborted) {
        try { await rpc($, { type: "cancel" }, 5_000); } catch { /* already gone */ }
      }
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
