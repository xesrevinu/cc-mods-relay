# Pitfalls

Hard-won constraints from shipping this relay. Product behavior lives in the [README](../README.md). This file is what not to undo.

Two machines, same names as the README:

- **This machine** — ACP client, workspace tools, real files.
- **TUI host** — persistent WebSocket server, Claude Code TUI, Mods plugin.

Do not put hostnames, usernames, tokens, private-network addresses, session ids, or live home paths in this file, in comments, or in tests.

## Where this came from

Mined from this repo’s Cursor chats (Nov 11–18 2026), including the user questions that first surfaced each class of failure. Two chats had no engineering content (stopped before work, and a model-usage-limit switch).

| When | Chat | What it burned |
| --- | --- | --- |
| Nov 11–12 | Architecture review | TUI + Mods + ACP shape; env allowlist; plugin embed after `bun` compile; PTY vs Mods for prompts; slash vs ACP; cwd flatten; mock API splash |
| Nov 12 | Orphan processes | herdr/SIGHUP leftovers; test fixtures leaking live paths |
| Nov 12 | Session id and history | fork/load/resume; `/usage` `/context`; 120s turn watchdog; queue vs steer; `_meta` at `session/new`; herdr session names |
| Nov 14 | Bash / direnv | `bash -c` skips direnv; rewriting results onto the TUI-host home; ToolSearch fail-closed |
| Nov 14–17 | Persistent WebSocket | Nix bun `SIGKILL`; Environment reminder is process cwd; do not set a custom API base URL to fake cwd; git stub; compact; JSONL rsync; Cursor worktree cleanup; string `{ result }` |
| Nov 17 | Path replace | `~` expansion; read vs write jail; subagent background hang; `$.session` used as a value |
| Nov 18 | Code Mode | `turn.complete` early; `{ deny }` vs business failure; hook-authored `isError` unloads the plugin; huge Read `{ result }` cannot be joined; local Bash env leaked client TZ/secrets |

---

## Mods plugin contract

### `tool.call` returns `{ result }` or `{ deny }` only

Anything else is skipped. Claude Code then runs the builtin on the TUI host. That includes:

- `{ isError: true, result: "…" }`
- `{ result: "<string>" }`
- extra fields such as `isError` next to a typed result
- an empty `result`

Core sets `isError` only after a builtin actually ran. A hook cannot author that form. Returning it skip/unloads the plugin: `session/prompt` hangs until timeout, and the plugin hellos after every tool.

**Rule:** Success is `{ result: <SDK object> }`. Refusal is `{ deny: string }`. Tests must forbid the source string `{ isError: true, result:`.

### `{ deny }` is “action not run”, not “tool failed”

The TUI shows `{ deny }` as permission denied. Mapping `TOOL_FAILED` / ENOENT / empty result through `failResult` → `{ deny }` made missing Reads look like the Code Mode classifier.

**Rule:** `{ deny }` only for a real refusal: `CANCELLED`, `UNAUTHORIZED`, `CALL_ID_CONFLICT`, `PATH_DENIED` (jail), and the RPC-catch “tool call was cancelled”. Business failure returns `{ result }` in that tool’s SDK shape and finishes the ACP tool as an error. Classify by error code, not by the words “permission denied” in a message. Filesystem `EACCES` / `EPERM` is `TOOL_FAILED` with text `Permission denied: …`, not `PATH_DENIED`.

### `next(e)` runs the TUI builtin

`next` is fallthrough to the host process. Workspace tools must not `next` on the success path, or Write/Edit will mutate the TUI tree.

Exceptions:

- After this machine has confirmed a Read ENOENT (`File does not exist:`), `await next(e)` and return that value. The TUI builtin emits native `tool_result.is_error` text, which a hook cannot produce. Safe only because the call is read-only and the file is missing on both sides.
- After this machine has started a background Bash, `next` a Mini-side waiter (`/tmp/cc-mods-wait/<callId>.done`) with `run_in_background: true`. The builtin owns that pid, so completion is origin `task-notification` and starts a turn immediately. `$.prompt.submit` of the same XML stays plugin-origin and queues as “Waiting to be delivered”. Do not `next` the original command.

**Rule:** Do not `next()` Write or Edit. Do not `next()` a subagent workspace tool just because it has `agentId` and no parent. Catch path: if it is a workspace tool and `!next.called`, cancel and `{ deny }`; otherwise `next(e)`.

### `$` may only go to a top-level helper

Two live load errors:

- `$` was passed to a minified nested name (`"V"`).
- `$.session` was used as a value (`a noun of $ bound, passed or read`).

Allowed: a top-level `function` declaration, a top-level const bound to one, or an import from the same file. Call sites are always `$.noun.event(...)`. `on` is always `on("<event>", hook)`. `next.to` is always `next.to(e, "<tier>")`.

**Rule:** Helpers that take `$` are top-level `function` declarations. Nested helpers may exist only if they do not take `$`. Never read `$.session` as an object; call `await $.session.id()`. Tests should reject `function name($` inside `register()`. Symptom of a bad hook shape is the same class of failure: plugin hello after every tool.

### The hooks module is not Node

No `WebSocket`, no `setTimeout`. Timers are `$.clock.after`. Processes are `$.process.run` / `$.process.spawn`. The helper is a short-lived spawned process that speaks one JSON object on stdin and one on stdout, not a socket kept open in the hook.

`$.session.id` is a function and may return a Promise. Call `await $.session.id()` on every `tool.call`. Do not guard with `$.session &&`.

### Helper close is not “kill the session”

Each hook RPC opens a loopback helper. When that socket closes, the server used to walk every call still attached to it and cancel them. Background Bash and Monitor register with `registerJob`. `{ type: "cancel" }` with no `callId` is `cancelSession` and kills every job.

**Rule:** Helper exit cancels that call only. Do not leave a background job’s id on a socket that is about to close. Do not emit a callId-less cancel because the helper hung up. Abort of the turn is not permission to reap background tasks the session is still waiting on.

Cancel precedence: `callId` → that call; else `agentId` → that agent’s jobs; else the session. Forward `agentId`, Claude session id, and TUI uid on the call, and `agentId` on cancel.

### Same `callId` is a cache key

Replay of the same id and signature is success, not a second execution. Reuse with different input is `CALL_ID_CONFLICT`. Call ids must be unique per input. Inner Code Mode calls use a `repl_*` prefix.

---

## Tool result schemas

Producers return Claude Agent SDK `ToolOutputSchemas` objects. A string was the original pitfall: Mods skipped the hook, the TUI builtin then failed “expected object, received string,” and the real path error was hidden. Extra keys are not free. Omit absent optional fields (`appliedOffset: undefined` is a schema error).

Canonical shapes to match exactly (no extras):

| Tool | Object |
| --- | --- |
| Read | `{ type, file: { filePath, content, numLines, startLine, totalLines } }` plus optional `truncatedByTokenCap` |
| Write | `{ type, filePath, content, structuredPatch, originalFile }` |
| Edit | `{ filePath, oldString, newString, originalFile, structuredPatch, userModified, replaceAll }` |
| Glob | `{ durationMs, numFiles, filenames, truncated }` |
| Grep | `{ mode, numFiles, filenames, content?, numLines?, numMatches?, appliedLimit, appliedOffset? }` |
| Bash / PowerShell | `{ stdout, stderr, interrupted }` plus optional background fields |
| NotebookEdit | `{ new_source, cell_type, language, edit_mode, notebook_path, original_file, updated_file, error? }` |

### Success fallback is not the failure shape

Reusing `objectResult` for errors made a failed Grep look like `{ numFiles: 0, filenames: [] }` (a real empty search) and a failed NotebookEdit look like `new_source: "<error text>"` (a real edit).

**Rule:** `errorResult` is a separate function. Grep/Glob empty-success objects are only for a search that ran and matched nothing. NotebookEdit failures set `error` and still fill the required fields. Bash failures are `{ stdout: "", stderr: message, interrupted: false }`. `interrupted: true` means aborted; do not wait the command out.

### `FileReadOutput.content` is file bytes

There is no error union on Read. Stuffing `File does not exist: …` into `content` looks like a successful read; the model treats it as a real file. Native missing-file behavior is Messages `tool_result.is_error` plus that text, which only the builtin can set. On the ACP side, an `is_error` Read is raw text, not a numbered fake file.

### `BashOutput` has no exit code

`test -e` on a missing file came back `ok: true`, empty stdout, stderr `Exit code 1`. The model reported the path as existing. Non-zero is still a successful tool result. `returnCodeInterpretation` is for non-error exit codes with special meaning.

**Rule:** Append `Exit code N` to stderr and keep `ok: true`. Do not map non-zero Bash to `{ deny }`. Missing files should be a Read (native `is_error`), not inferred from empty stdout.

### Truncation is a success flag

SDK `truncatedByTokenCap` means a whole-file read was auto-paginated past the token cap; `content` is only the first page. This relay’s default whole-file cap is 2000 lines **and** 2 MiB of UTF-8. 2000 fat lines (each already clipped to 2000 characters) is ~4 MiB, which Mods splits across hook parts. Hook-authored `{ result }` objects for those parts cannot be joined: “The tool's result was not delivered… ask for less at a time (for a file, use offset and limit).” A ~1 MiB Read still fits in one `{ result }`. Do not `next()` a large workspace Read to dodge this — the builtin would read the TUI host. Glob `truncated` is the SDK limit of 100 files. Grep’s default mode is `files_with_matches`; set `mode` / `content` / `numMatches` when the caller asked for content or count.

Do not invent a Read error arm for truncation. Code Mode `file().text()` of a multi-megabyte jsonl should be Bash/`jq` or a paged Read.

---

## Code Mode

Opt-in (`config.json` `codeMode` or `CC_MODS_CODE_MODE`). `REPL` stays on the TUI host. Inner `$` / `file()` become Bash / Read / … on this machine (`repl_*` call ids).

### Official gates

- Claude Code ≥ 2.1.323. A `tool.call` mod plus Code Mode together need ≥ 2.1.327. Before that, “it doesn't yet work with an installed mod” refused startup. The docs line that a tool-checking mod blocks Code Mode is stale as of 2.1.327.
- `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1`. A `0` in shell, user settings, or managed settings wins over a `1` elsewhere. Claude Code ignores this variable in a project’s settings files. Do not persist `CC_MODS_CODE_MODE` back into `config.json`.
- First run writes `codeModeCaveatsAcceptedV1` and `codeModeAutoModeCaveatAcceptedV1`, then restarts the TUI (plugin hello two or three times). A prompt sent during that restart is dropped. Wait on the order of 20–25s before the first prompt. Resume only works with the variable still set.
- Interactive terminal `claude` only. Not `-p`, Agent SDK, VS Code, Desktop, or cloud.
- Will not start with an API key helper, `ANTHROPIC_AUTH_TOKEN`, `Authorization` / `X-Api-Key` in `ANTHROPIC_CUSTOM_HEADERS`, a custom `ANTHROPIC_BASE_URL`, `DISABLE_TELEMETRY`, or OpenTelemetry.
- Spawn: do not pass `--restricted`; add `REPL` to `--tools`; remove `REPL` from `--disallowedTools` and deny rules. This relay uses `--allowedTools Grep,Glob,REPL` when there is no `--tools` whitelist.
- `REPL` is not `isLocalTool`. Inner calls still arrive as Bash / Read / … and must still be intercepted. Check the script with a `PreToolUse` hook on tool name `REPL`, reading `tool_input.code`. Each inner call is checked under its usual name.
- Auto-mode classifier reviews each piece of code, not each tool call, and does not see runtime values. `bypassPermissions` does not remove that. Do not explain a permission-denied row as this classifier until you have checked whether the plugin returned `{ deny }`.
- Waiting code stops after ten minutes, including time at permission prompts.
- Do not revive the disabled MCP “replace builtins with `mcp__…__Read`” path. It races the Mods hook.

Caveats file mode is `0600` only. If `CLAUDE_CONFIG_DIR` is set, write only that tree’s `claude.json`, never also the home one. `couldn't save your answer` means that json is not writable.

### `turn.complete` is not the end of a Code Mode turn

Official contract is that `turn.complete` covers the whole turn. Code Mode emits it after the `REPL` tool use, before the sandbox finishes. ACP `session/prompt` then returned in a few seconds with no inner tools. Stopping the client killed the sandbox.

The first `REPL` result is a dispatch stub (`(dispatched #1)`), not the finished script. Counting that stub as an in-flight hold deadlocks the turn.

**Rule:** Treat `turn.complete` as a candidate. If this turn saw `REPL` or still has in-flight inner tools, wait (~15s settle, then 400ms quiet after the last tool, with an 8s idle cap). If there was no `REPL`, flush immediately. Do not stack the 8s plugin grace on top of the 15s ACP settle. An abort flushes immediately. `turn.start` / `session.start` must reset any pending complete so a stale `turn_completed` cannot cancel the next prompt.

Do not hold `REPL` itself. Hold only inner `repl_*` calls. Do not parent a tool under a `REPL` whose id is the tool’s own id. Skip a duplicate `tool_started` for an id already open.

### JSONL observation cuts the settle wait

Live JSONL `observe()` treated assistant rows as a terminal boundary and fired through `settleMs`. `session/prompt` still returned in 4–9s with no answer.

**Rule:** When `turnSettleMs > 0`, do not observe JSONL on the live Mods path. JSONL writes must not cancel an armed settle. `REPL` cards for ACP come from a JSONL mirror, because `REPL` usually never hits `tool.call`.

`BUN_TEST` is unset in this Bun. Do not infer settle from the environment. Pass `turnSettleMs` through agent deps from boot: 15s only when Code Mode is enabled, 0 in tests.

### The sandbox is not a Node project

No `import` / `require`. `$` and `file()` become workspace tool calls only when the plugin is loaded; otherwise they touch the TUI filesystem. `Promise.all` in the script is real concurrency: several `repl_*` calls are in flight before the first result.

**Rule:** E2E fixtures must be a cwd both sides can name, with the bytes on this machine. Judge success by inner `ws call` tools here, not by files appearing on the TUI host. Keep the ACP session up through the settle window. A stuck local harness is not evidence the TUI is stuck.

---

## Paths, cwd, Environment

### The model follows the TUI process cwd

`safeGetCWD()` is `process.cwd()`. The Environment block is a `<system-reminder>` on the first user message (Primary working directory, git boolean, Additional working directories, platform, shell, OS). It is not part of the default `system` blocks.

`--system-prompt` replaces system text and does not touch it. `--append-system-prompt-file` cannot override it. `--system-prompt-snapshot` freezes system text, not the reminder. The reminder is re-injected on compact and on subagents. Appending git / platform / shell / memory-file text was redundant: Claude already loads `CLAUDE.md` and `AGENTS.md`. Do not add more append to “fix” tool behavior; fix the tool shapes.

**Rule:** The TUI cwd string must be the client path. mkdir that absolute path on the TUI host when the filesystem allows it. Do not try to out-prompt the reminder. Do not set `ANTHROPIC_BASE_URL` to rewrite it: a non-first-party host flips gateway behavior, Remote Control, fine-grained tool streaming, first-byte deadlines, and OAuth. `DYLD_INSERT_LIBRARIES` does not work against the signed binary.

A hash cwd (`…/tui/<hash>`) looks empty and trips folder-trust. Flatten under the same path the client uses. Placeholder directories must not use words like `relay` or `proxy`. Copy project `AGENTS.md` / `CLAUDE.md` / `.claude/` / `.agents/` into that folder at start, plus user-level skills; hash both scopes so startup does not recopy every time.

`session/new.cwd` is the client pwd. `initialize` typically has no cwd. `_meta` is not a cwd channel. Prefer the client path when it exists. `--add-dir` is Additional working directories only; it does not change Primary. `CLAUDE.md` from an add-dir needs `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`.

### Rewrite inbound tool inputs only

Mapping results back to the TUI-host home made the model believe two homes. A blind username replace invented paths that do not exist here.

**Rule:** Longest prefix on the way in (TUI root, then TUI home). Bash / Read / Write results show real workspace paths. Do not rewrite results back onto the TUI-host home — that is how the model learned two homes and started every turn with `cd`. The model should have no way to observe the TUI-host home. Do not special-case `.cursor`. Do not hardcode a `Workspace/` prefix. When the two account names differ, the inbound prefix map is the whole fix; do not also map the way out.

### `~` expansion needs a left boundary, and `$` in the replacement is special

`replacePathPrefix` that only checked the character after `~` turned identifier suffixes (`token~`) into `token/<home>`, and also rewrote `=~` and `file.txt~`. `String.replace` with a string replacement treats `$` in the destination as a backreference.

**Rule:** Expand `~` only at the start of a path token (`~/x`, `cd ~`, `VAR=~/x`). Use a function replacer so `$` inside the destination is literal.

### Explicit `$HOME` paths are writable; relative `../` is not

Jailing Write to the session cwd blocked a sibling checkout (`…/github/<other>/scripts/prebuild.py` → `PATH_DENIED: Path is outside …/github/<project>`). Native Claude Code does not invent that jail. Read already allowed explicit home paths; Write did not.

**Rule:** Read / Write / Edit / NotebookEdit share `mapExplicitHomePath`: workspace, extra dirs, common scratch, or an explicit absolute / `~` / `$HOME` path under the home directory. Scratch is `/tmp`, `/var/tmp`, `$TMPDIR`, `~/.cursor`, `~/.claude`, `~/.local/share`, Linux `/dev/shm`, macOS `/var/folders`, and `$XDG_RUNTIME_DIR` when set. Live JSONL habits that belong here: sibling checkouts, `~/.cursor/worktrees`, `~/.cursor/artifacts`, `~/.claude/projects/*/memory`, `~/.claude/plans`, `~/.local/share/references-repos`, and `/tmp` experiments. Each `/tmp` and `/var` root also includes its macOS `/private/…` spelling — Bash persists cwd from `pwd -P`, so `/tmp` without `/private/tmp` drops `cd /tmp`. A relative `../` still throws (`../.ssh`). `/etc` still throws. Do not persist `cd` into an arbitrary home folder such as `~/.ssh`. Do not silently rewrite a Bash command into a Read. A prefer-file refusal is `TOOL_FAILED` that names the Read or Grep to use.

A Bash `cd` outside project/scratch/extraDirs is still not persisted for later relative Write. Official background-command hint: directory changes made by the backgrounded command do not apply to subsequent commands. `EnterWorktree` may still change cwd.

### Git stub must match the client branch

`git init` with no branch made Environment `gitBranch` `main`. Detached worktrees were missed because `symbolic-ref` alone fails there. The model then `cd`’d as if it were on `main`.

**Rule:** Read client git as symbolic-ref, then `branch --show-current`, then worktree porcelain, then `name-rev`. Stub with `git init -b <branch>`. If `{ repo: true }` but the branch is unknown, do not invent `main`. If `{ repo: false }`, leave the directory without `.git`. Never `git init` `/`, `/Users`, `/home`, or a home directory itself.

### macOS `/var` is `/private/var`

`git worktree list` prints `/private/var` while `join` produced `/var`. direnv tests compared `pwd` to a `/var/folders` path and failed. The same split applies to `/tmp` vs `/private/tmp` for Write jail and persisted `cd`.

**Rule:** Compare `pwd -P` / `realpath` on both sides. Scratch roots must list both spellings. EnterWorktree requires the path to be in `git worktree list` after realpath. Name XOR path. Exit requires `action: "keep" | "remove"`. Trust keys also differ for `/var` vs `/private/var` until `realpath`.

---

## Bash, direnv, background work

### `bash -c` does not load direnv

Non-interactive `Bun.spawn(["bash","-c",…], { cwd, env: process.env })` has no direnv hook. A one-off ACP process that inherited direnv from its parent made a local probe look fine. `direnv export json` is a diff; JSON `null` means unset. Non-zero export leaves the base env unchanged.

**Rule:** Merge `direnv export json` in `withDirenv` before foreground and background spawn. Do not tell the model to wrap `direnv exec` once that is deployed. Do not assume BSD `sed` under a direnv `PATH`.

### Official Bash timeout backgrounds; it does not kill

Foreground default 120s, max 600s. On timeout return partial output with `interrupted: false`, `backgroundTaskId`, and `timedOutAfterMs`; keep the process; drain about 2s; then apply the background timeout (default 30 min, max 2 h). Notify `kind: "background"` on later exit. Do not persist cwd for an auto-backgrounded command; if it contained `cd` / `pushd` / `popd` / `chdir`, set `backgroundCwdHint`. Commands that start with `sleep` are never auto-backgrounded. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` disables the feature.

Monitor is a background line stream (`taskId`, `timeoutMs`, `persistent?`); timeout 0 means persistent. Running Monitor as foreground Bash blocked until the cap; denying it made the model ToolSearch `select:Monitor` and then poll with `sleep`.

### Sequential prefer-native must fail open

CC 2.1 on macOS/Linux drops dedicated Glob/Grep unless named. `--tools` is a whitelist and drops Agent, WebSearch, and the rest. `--tools default` does not restore Glob/Grep. `--allowedTools Grep,Glob` is additive.

A command-wide veto denied hundreds of heredocs that must run. Matching `sed` through the whole line, including redirects, classified `sed -i; <build>` as Edit. Glued `-A30` was not seen as a context flag. `--type-add` was sent to Grep. `perl -version` was treated as in-place.

**Rule:** Per pipeline stage, mutation check then native-tool check. Split only quote-aware `&&` and `;`. Abort the split on unquoted `<` `>`, backticks, newline, `$()`, `|`, `||`, a lone `&`, or an unclosed quote. Heredocs and pipes stay Bash. A lone `sed -i` / `perl -i` prefers Edit; `sed -i` followed by another command stays Bash. `$N/foo` is not a Read path. Strip `2>/dev/null` before classifying. Ignorable-only commands (`ls` / `pwd` / `echo`) stay Bash. A leading `cd` onto the session cwd is dropped and the rest still runs; put `Already in the working directory…` on stderr so the model can see it. Do not `{ deny }` that call. Persist cwd only for a completed foreground command in-session.

---

## Subagents and task files

Claude Code tells the model that background output is `…/claude-<uid>/<encoded-cwd>/<session-id>/tasks/<pid>.output` and appends that sentence itself. Writing a private temp log made `cat` of that path `No such file or directory`. Subagents then `until` / Monitor / `cat` that missing file for minutes.

**Rule:** Write (and tee timeout-promoted output to) that tasks file. Encode the TUI session cwd, not this machine’s cwd: strip trailing slashes, then every non-alphanumeric byte becomes `-` (a slash before a dot becomes a double hyphen). Uid is `id -u` on the TUI host, sent on the call. If that uid is missing, do not guess this machine’s uid.

### `prompt.submit` has no agent target

`$.prompt.submit({ text })` delivers to the main session. A subagent that started the job then waited forever. Always falling back to `prompt.submit` stole notifications from subagents that were still alive. Subagent delivery is `$.session.send`. `isDelivered !== false` means accepted, including queued. `isDelivered: false` is failure.

**Rule:** If the call has an `agentId`, `session.send` to that agent. On failure, submit to the parent only when the agent is gone (not resumed, not messaged, no live teammate, no SendMessage tool). Otherwise retry. Main-session notifications use `prompt.submit`, and retry when the reason is session-stopped or queue-removed. `turn.start` only marks the main session busy when `agentId` is absent, but it should still flush that agent’s pending notifications.

Pending items are `{ text, agentId }`. Flush that agent on its own `turn.complete`, on `turn.start`, and before the next listen delivery. Also retry on a 1.5s Mods timer (`$.clock.after`, not `setTimeout`). Cap at 100, but never evict a `<task-notification>` to store a Monitor line. `$.clock.after` depends on the Mods clock; that is a known low risk.

Plugins cannot set prompt origin. `<task-notification>` from `$.prompt.submit` stays plugin-origin. `asUser` is still plugin-origin. Official background completion cannot be spoofed from a plugin. For a Mac-side background Bash, hand a waiter to the TUI builtin instead of submitting that XML; keep `prompt.submit` only when `next` of the waiter is denied.

---

## ACP turns, fork, resume, compact

### Live Mods path skips JSONL linearize

`liveFromMod || modChannelConnected()` skips linearized content. Tool events that did not call `noteActivity` let the 120s stall watchdog fire while Claude was still working. Test schedulers that run delays ≤200ms immediately also fired the production 120s value.

**Rule:** Hold the watchdog and `noteActivity` on tool traffic. Keep JSONL observe on the Mods path for terminal stop only when Code Mode settle is off, without emitting linearized content twice. In tests, only short delays fire immediately. `turn.complete` must not wait for a `result` record the relay never sends.

### Overlapping `session/prompt` cancelled the turn

The idle `sendPrompt` writes Escape, Ctrl+U, text, Enter. Escape cancels Claude. The client treats overlapping `session/prompt` as a server-side queue. Steer / interject / send-now must not send Escape.

**Rule:** Queue until ACP end-of-turn, then submit the next prompt.

### Fork and load

- Check `storedSessionExists` before spawn; do not map every resume/fork error to resource-not-found after a 30s ready timeout.
- Spawn is `--resume SOURCE --fork-session --session-id NEW`. Resuming the new id has no parent transcript.
- Fork does not stream history. Follow it with `session/load` when load is advertised. Wait until the child transcript inherit count is in, then fall back to the parent.
- `loadSession` of a dead session must `claude --resume` in the cwd recorded in the JSONL, not replay-only against an empty PTY. Replay-only only if that session is already live.
- `getMessages` can return `{ type: "permission-mode" }` whose `content` is not an array. Skip those records.
- `listSessions` must not assume the ACP `cwd` argument is the JSONL directory. Store `clientCwd`. The projects directory is keyed by encoded TUI cwd; a mapping change moves the file and resume misses it.
- Resume without `--model` resets the model. Take the last main-thread assistant `message.model`.

### Compact

Default `includeSystemMessages: false` omits `type: "system", subtype: "compact_boundary"`. JSONL uses camelCase `compactMetadata`; the SDK type uses snake_case `compact_metadata`. Complete on the summary, not on the boundary, when this is the live compact. Hold the stall watchdog for the duration (can run ~30s and longer). ACP `compaction_update` only if the client advertised `session.compaction {}`. Hide `/compact` from replay (`REPLAY_HIDDEN`). Cancel is `session/cancel` plus PTY Ctrl+C/Esc, and must still settle the in-flight prompt (`stopReason: cancelled`).

### Transcript mirror

Init is `rsync` of every project JSONL on the TUI host, not the current cwd. Live is `transcript.append` in chunks, with cursors `{ sessionId: { rel, offset } }`. Flush on `instance.start`, `turn.complete` (JSONL is often written after the turn), 1s idle, and teardown. Register the message listener before `instance.start`. On a dropped frame, rewind `sent` and resend. `turn.start` flushes and arms idle; it must not cancel the idle flush. A failed rsync is retried once; the session still starts. Loopback skips rsync. A block comment must not contain `*/` (a glob like `projects/**/*.jsonl` terminated the comment).

Resume, fork, and list still read the files on the TUI host. `CLAUDE_CONFIG_DIR` is the tree to watch, not `homedir()/.claude`.

### Session create meta and usage

Seed permission mode from client `_meta` (`yoloMode` / `autoMode`), then host `defaultMode`, then `bypassPermissions` if allowed. Honor yolo/auto strictly when the keys are present. `askUserQuestion: false` gate-denies AskUserQuestion. Ignore non-UUID `sessionId` and unknown model ids. Consume every create-session meta field.

Emit ACP v1 `usage_update` with `used` / `size` / `cost`. Stamp `PromptRequest._meta.promptId` onto relay `session/update`. Do not coerce missing cost to `$0.0000`. One silent `get_usage` with `persistSession: false`; do not resume a second query to read meters (it double-writes JSONL). `/context` on 2.1.x writes markdown (`isMeta` + `local_command`), not always the object. Hide `/context` and `/compact` from replay so they do not enter the next API turn.

Extension methods are `_{method}` with transparent params. `session/info` is an `{ result, error }` envelope. `session/usage` is a bare `{ usage }`. Do not use one envelope for both.

### Slash commands that have no ACP equivalent hang

`/usage` and `/context` were forwarded as ordinary prompts and never came back. Plan/debug/diff/sandbox/skill/plugin slashes that have no ACP request should not be advertised. `/compact` injected into the TUI with no `compaction_update` left the ACP client with no notification.

**Rule:** Only advertise slashes the client can actually call. Answer `/usage` and `/context` in `prompt()` with `end_turn`, or via `session/info`. Hide those records from replay so they do not enter the next API turn.

### Print mode is not the production path

`claude -p` can “prove” tools while production TUI + herdr still fails. `--tools` and `--allowedTools` are variadic and will eat the argv prompt (“Input must be provided through stdin”). `CLAUDE_CODE_SIMPLE=1` / `--bare` skip the probe and also skip plugin hooks. Production is TUI + herdr. Put the prompt on stdin.

---

## Tool forwarding

A catch-all `tool.call` with no matcher and no `next` forwards every tool. Agent, Skill, and WebSearch then fail on this machine, or workspace tools run on the TUI host.

**Rule:** Workspace (Read / Write / Edit / Glob / Grep / NotebookEdit / Bash / PowerShell, including subagent Read / Write) → RPC here, never `next` on success. Deny (LSP, and deferred tools the executor does not want as native): `UNSUPPORTED_TOOL`, not a fabricated success. Native-on-host: Agent, Skill, WebSearch, TodoWrite, AskUserQuestion, PlanMode, MCP, Cron. Hydrate-then-native for Artifact / DesignSync `file_path`: if the copy fails, the builtin still runs and the TUI copy can be missing — do not treat hydrate failure as success of the read.

ToolSearch must work. Tools that Claude Code exposes by default must not fail closed; only extra tools need enabling. Monitor is a background line stream, not a foreground Bash. Compress images before base64 (around 85% is enough). Do not open ACP `fs/*` or terminal caps: the client would then try to serve files itself instead of the Mods WebSocket.

Client fs/terminal caps off means ACP `fs/*` is not the tool path; Mods WebSocket is. Permission UI for host-native dialogs is `classic.PermissionRequest`. Submit prompts through the PTY. Reading structured events from Mods is fine; `$.prompt.submit` is not a real user turn.

Mods forbids `WebSocket`, timers, and passing `$` into nested helpers, so the long-lived `listen` `ws-client.js` process owns the persistent WebSocket and binds a short Unix socket (`/tmp/cc-mods-rpc-*.sock`) for `$.http.fetch` (`/rpc` + 20s `/wait` slices for long Bash), falling back to `$.process.run` only when the listener is down. That also lets `ws-client.js` compute `tuiEnv` once on `listen` / `hello` instead of spawning `readlink` or `defaults` on every `Read` / `Edit`. Also guard `Read` ENOENT with `test -e` before `next(e)` so a stale file on Mini never satisfies a missing file on this machine, and intercept `TaskStop` for Mini waiter / Client `Monitor` tasks.

---

## Environment and credentials

`Bun.spawn({ env })` replaces the child env. Copying `process.env` leaks SSH and cloud secrets. `bash -lc` then sources a login profile and can put them back, or override `ANTHROPIC_*`.

**Rule:** Inherit the TUI-host user session and strip billing vars and relay internals (`FORK_*`, `CLAUDE_TUI_*`, `HERDR_ENV` / `HERDR_SESSION`, `CC_MODS_*` except `CC_MODS_SOCKET`). Keep TERM, COLORTERM, FORCE_COLOR, PATH, locale, XDG, EDITOR, `SSH_AUTH_SOCK`. Spawn with `bash -c`, not `-lc`. Anthropic creds and `CLAUDE_CONFIG_DIR` are spawn-env only. ACP `initialize` has no env field; flags may ride `_meta`, secrets must not. Extra directories go in a sidecar file, not `process.env`.

Local Bash / Monitor run on this machine, so a raw `process.env` copy would show this laptop’s timezone, language, Cursor/`TERM_PROGRAM`, SSH agent, and cloud tokens. macOS usually leaves `TZ` unset, so `date` follows `/etc/localtime` — overlaying only when Mini exported `TZ` left this laptop on its own timezone. The Mini helper must always send an IANA zone (`TZ` env, `readlink`/`realpath` of `/etc/localtime`, then `Intl.DateTimeFormat`), and `LANG` (`LANG` env, `AppleLocale`, then Intl). Wipe every client `TZ` / `LANG` / `LC_*` / `TERM` key before applying that snapshot, and pin again after direnv so a client `.envrc` cannot put the client timezone back. Also copy Mini `TERM` / `COLORTERM` / `FORCE_COLOR` (engine-pty sets `xterm-256color` / `truecolor` / `3`). PATH and HOME stay this machine’s — the tools have to run here. Do not rewrite `hostname`. `tuiEnv` may only carry those face keys; ignore `PATH` or other injection. Same-machine replay sets `CC_MODS_TUI_ENV` so the helper does not snapshot this laptop as if it were Mini.

`CC_MODS_DEBUG` and `CC_MODS_DEBUG_FILE` are the TUI-host server’s environment. Logs opened on this machine stay empty.

The serve process freezes `HOME` and `USER` at start. After an account or home change, restart serve and rewrite absolute `claude` / `bun` symlinks. Session project dirs are the encoded cwd (`/` → `-`); old encodings must be merged, not left beside the new ones.

Token comes from the config file, never argv, so it does not show up in `ps`.

---

## Deploy and TUI host

- Compile with Homebrew bun on this machine, then copy. A Nix-built bun dies on ICU. After copy, ad-hoc sign (`xattr -cr`, `codesign --force --sign - --timestamp=none`) or the binary is `SIGKILL` 137 even on `--version`.
- Embed plugin text and the agent bundle at compile time. Bun compile does not keep sibling plugin files. Bake the endpoint before minify, or `ENDPOINT` is renamed. Register bundle target is `browser` (no `// @bun`); helpers are `bun`. Nested `$` helpers are rejected at load. Plugin load `/$bunfs/root/../plugin/...` means the embed path is wrong.
- Unix `/hello` before the WebSocket. Tools upgrade is loopback-only; an `Origin` header on the session upgrade is rejected. ACP is `{ jsonrpc: "2.0" }`; custom frames are `{ v: 1 }`. `instance.start` is first. Await `connection.closed`. Teardown only if `inst.client === ws`. Log on stderr. Do not `process.stdin.resume()` after `Bun.stdin.stream()` (“ReadableStream is locked”).
- `herdr pane run` types into the login shell. Pass `--env SHELL=/bin/sh`. A relative `bin/sh` does not exist. Ready text on 2.1.x is “auto mode on (shift+tab to cycle)”, not “for shortcuts”. Auto-dismiss first-run theme / API-key / trust / bypass / “Try the new fullscreen renderer?” dialogs (fullscreen prompt selects “Not now”); herdr’s one-shot Down+Enter does not dismiss folder-trust. `trustTuiCwd` patches the host Claude config and retries Enter.
- Stale SSH ControlMaster hangs doctor. Skip loopback `-R` when the relay port is already bound. zsh does not treat `exec KEY=val cmd` as an assignment; use `exec env KEY=val bun`. For remote inspection, write a script and pipe it. Do not embed shell metacharacters in a heredoc the login shell parses.
- The TUI probes a hardcoded first-party host and ignores `ANTHROPIC_BASE_URL` for the splash. `DISABLE_STARTUP_WORK_GATE` does not reroute it. Pre-approve the key suffix (last 20 characters) in `customApiKeyResponses.approved`, and pin base URL plus key in `settings.json` `env`. Mock must answer GET `/api/hello` with 200, not only HEAD. `CC_MODS_MOCK=1` refuses to start unless the base URL is loopback. With `CLAUDE_CONFIG_DIR` set, Claude 2.1 reads `configDir/.claude.json`, not the home one.
- Handle SIGHUP with the same shutdown as SIGTERM. `ensureHerdr` `unref()`s the server, so panes are not in the SSH process tree. Mark TUI exit only when every seen pid is dead (bun still in the pane is not exit). Kill seen pids before `workspace close`. On the next agent start, reap stamped dead-agent panes, PPID-1 `claude --plugin-dir` / `ws-client.js`, and unstamped tui panes. SIGKILL still leaks until that next start. An empty herdr daemon after a clean exit is intentional. `ws-client.js` reconnects about every 500ms if left behind.
- A `\bclaude\b` rewrite corrupted paths like `/tmp/claude-abc`. Rewrite is `(^|[\s;|&])claude(?=[\s]|$)`.
- Claude may scaffold `.claude-plugin/types` on load; that is not part of the shipped tar.
- `{type:"http"}` MCP entries need headers at create. Set `mcpServers` on the session after create.
- A leftover gitdir index restores staged files via `checkout-index -a -f`. Unstaged files exist only in the working tree. Do not `git worktree prune` while recovering a vanished checkout. Cursor’s worktree cleanup can delete a live checkout; `cursor.worktreeCleanupIntervalHours` above 596 overflows and the loop keeps running. That is not this relay deleting files.
- Herdr UI session names must stay neutral (`claude` / workspace label `claude-tui`). Words like `remote` / `relay` in the session name show up in the local machine sidebar.
- If the ACP client creates a session and the user quits with no work, close/delete that empty session.
- Plugin helper exit 137 after copy is usually unsigned / Nix bun, not “the model ran out of memory”. If the WebSocket drops, the TUI keeps running; the next client connect must not leave a half-started instance (`inst.client === ws`).

---

## Tests and this file

- Fixtures use nonexistent homes. `existsSync` against a real home path collapses the assertion. Do not scan the entire home. Public tests stay on fake paths (`/tmp/…`) or a `/.cc-mods-relay/` match. Do not copy live `ps` lines into the repo. Do not match exact usage, token counts, or timezones. Do not put a real `/Users/<name>/` marker in e2e scripts. Comments that skip `git init` of a home directory must not contain a real account name.
- Public docs name ACP, Claude Code, and this binary. They do not name internal hosts, other products used as the ACP client, or how to bypass Claude Code.
- `bun check src/index.ts` is the type gate that matters. Whole-repo `bun check` still reports pre-existing test errors. The plugin file is not cleanly typechecked under the plugin tsconfig.
- `bun build` from a temp dir cannot resolve the SDK. Build from the repo.
- `??` mixed with `||` is a Bun parse error and TS5076. Split the expressions.
- JSONL watcher tests flake on timing. Watch operator precedence around `JSON.stringify` and `repeat` when measuring byte size.
- `claude -p` in an isolated config dir is not a substitute for TUI + herdr + ACP stdio.

---

## Known leftovers

- NotebookEdit still uses the strict path mapper, not the write-mapper-plus-memory exception.
- `$.clock.after` will not fire if the Mods clock does not.
- Hydrate failure still lets the TUI builtin run against a missing copy.
- Debug logging on the TUI host is easy to leave on after a live investigation.
