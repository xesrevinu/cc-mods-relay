/**
 * Replay daily Claude Code tool habits (from local JSONL) against a real
 * `claude -p` + this plugin. Paths are remapped onto a disposable tree under
 * ~/Workspace/tmp-cc-mods-replay. No live homes, emails, or session ids.
 *
 * Habits this run mirrors (84 parent jsonl, ~9.7k tool_use):
 *   Bash cd-and / cd-only / cd-tilde / cd-dotdot / cd-tmp
 *   REPL then Poll; REPL $`…` and file()
 *   Edit/Read/Write ~/.cursor/worktrees
 *   Read/Write/Grep sibling github checkout
 *   Write /tmp; Write ~/.claude/projects/<session>/memory
 *   Read ~/.local/share/references-repos
 *   Read with offset+limit (~half of Reads)
 *   Write+Bash in one turn
 *
 *   bun scripts/replay-jsonl.ts
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CODE_MODE_ENV } from "../src/config.js";
import { acceptCodeModeCaveats } from "../src/environment.js";
import { startMockAnthropic, toolResultsFromBody, type ScriptedTurn } from "../src/mock-anthropic.js";
import { startRelay } from "../src/relay.js";
import { stagePlugin } from "../src/launch.js";
import { REDUNDANT_CD_HINT } from "../src/tools/bash-intent.js";
import { MARKER, claudeBin, claudeEnv, runPrintClaude, testApiKeySuffix } from "../test/harness.js";

function toolId(name: string): string {
  return `toolu_01${name.replace(/[^A-Za-z]/g, "").padEnd(20, "X").slice(0, 20)}000000`;
}

function blob(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

type Check = {
  id: string;
  live: string;
  name: string;
  input: Record<string, unknown>;
  expect?: (content: unknown) => string | undefined;
};

const bin = claudeBin();
if (!bin) {
  console.error("claude is not on PATH");
  process.exit(1);
}

const home = homedir();
const stamp = `${process.pid}`;
const homeIso = join(home, "Workspace", "tmp-cc-mods-replay", `iso-${stamp}`);
mkdirSync(join(homeIso, "project", "src"), { recursive: true });
mkdirSync(join(homeIso, "tui", "src"), { recursive: true });
mkdirSync(join(homeIso, "claude-config"), { recursive: true });
const iso = {
  root: realpathSync(homeIso),
  project: realpathSync(join(homeIso, "project")),
  tui: realpathSync(join(homeIso, "tui")),
  config: realpathSync(join(homeIso, "claude-config")),
};
writeFileSync(join(iso.project, "hello.txt"), `${MARKER}\n`);
writeFileSync(join(iso.tui, "hello.txt"), `${MARKER}\n`);
writeFileSync(join(iso.project, "AGENTS.md"), "# agents\n");
writeFileSync(join(iso.tui, "AGENTS.md"), "# agents\n");
writeFileSync(join(iso.project, "CLAUDE.md"), "use bun\n");
writeFileSync(join(iso.tui, "CLAUDE.md"), "use bun\n");
const trusted = {
  hasCompletedOnboarding: true,
  theme: "dark",
  opusProMigrationComplete: true,
  sonnet1m45MigrationComplete: true,
  firstStartTime: "2026-01-01T00:00:00.000Z",
  bypassPermissionsModeAccepted: true,
  customApiKeyResponses: { approved: [testApiKeySuffix()], rejected: [] as string[] },
  projects: {
    [iso.tui]: { hasTrustDialogAccepted: true },
    [iso.project]: { hasTrustDialogAccepted: true },
  },
};
writeFileSync(join(iso.config, ".claude.json"), JSON.stringify(trusted, null, 2));
writeFileSync(join(iso.root, ".claude.json"), JSON.stringify(trusted, null, 2));

const worktree = join(home, ".cursor", "worktrees", "cc-mods-replay");
const claudeMem = join(home, ".claude", "projects", "-cc-mods-replay", "memory");
const refs = join(home, ".local", "share", "references-repos", "cc-mods-replay");
const sibling = join(home, "Workspace", "tmp-cc-mods-replay-sib");
const tmpHabit = join(tmpdir(), `cc-mods-replay-habit-${stamp}.txt`);
const privateTmp = `/private/tmp/cc-mods-replay-habit-${stamp}.txt`;
const projectTilde = iso.project.startsWith(home) ? `~${iso.project.slice(home.length)}` : iso.project;

function seed(dir: string, file: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, body);
  return path;
}

const paged = Array.from({ length: 80 }, (_, i) => `line-${i + 1} ${MARKER}`).join("\n") + "\n";
seed(join(iso.project, "src"), "lib.ts", paged);
seed(join(iso.tui, "src"), "lib.ts", paged);
writeFileSync(join(iso.tui, "stale-on-mini.txt"), "MINI_STALE_CONTENT\n");
const largeBody = `marker-line-0001\n${`${"z".repeat(1200)}\n`.repeat(520)}`; // ~624 KiB, over WRITE_DIFF_BYTE_CAP
const largeFile = seed(join(iso.project, "src"), "large.txt", largeBody);
writeFileSync(join(iso.tui, "src", "large.txt"), largeBody);
const worktreeFile = seed(join(worktree, "src"), "a.ts", `export const n = 1;\n${paged}`);
const siblingFile = seed(join(sibling, "src"), "prebuild.py", "print('sib')\n");
seed(claudeMem, "note.md", "memory-ok\n");
seed(refs, "x.rs", "fn main() {}\n");

function looksDenied(t: string): boolean {
  return /PATH_DENIED/i.test(t) || (/permission denied/i.test(t) && !/File does not exist/i.test(t));
}

function looksMissing(t: string): boolean {
  return /File does not exist/i.test(t) || /no such file/i.test(t);
}

function looksShape(t: string): boolean {
  return /does not match its output shape/i.test(t) || /can't be joined/i.test(t) || /shown it in parts/i.test(t);
}

const checks: Check[] = [
  {
    id: toolId("ReadWorktree"),
    live: "Read ~/.cursor/worktrees (809 of 849 .cursor paths) with offset+limit",
    name: "Read",
    input: { file_path: worktreeFile, offset: 1, limit: 20 },
    expect: (c) => {
      const t = blob(c);
      if (looksDenied(t)) return `worktree read denied: ${t.slice(0, 160)}`;
      if (looksMissing(t)) return `worktree missing: ${t.slice(0, 160)}`;
      if (looksShape(t)) return `shape: ${t.slice(0, 160)}`;
      if (!t.includes("export const n")) return `unexpected: ${t.slice(0, 160)}`;
      return;
    },
  },
  {
    id: toolId("ReadPaged"),
    live: "Read project file with offset+limit (220 of 519 Reads are paged)",
    name: "Read",
    input: { file_path: join(iso.tui, "src", "lib.ts"), offset: 1, limit: 15 },
    expect: (c) => {
      const t = blob(c);
      if (!t.includes("line-1")) return `paged miss: ${t.slice(0, 160)}`;
      if (looksShape(t)) return `shape: ${t.slice(0, 160)}`;
      return;
    },
  },
  {
    id: toolId("ReadSib"),
    live: "Read sibling github checkout (208 Reads)",
    name: "Read",
    input: { file_path: siblingFile },
    expect: (c) => {
      const t = blob(c);
      if (looksDenied(t)) return `sibling read denied: ${t.slice(0, 160)}`;
      if (!t.includes("sib")) return `unexpected: ${t.slice(0, 160)}`;
      return;
    },
  },
  {
    id: toolId("GrepSib"),
    live: "Grep sibling checkout (106 Greps)",
    name: "Grep",
    input: { pattern: "print", path: sibling, glob: "*.py" },
    expect: (c) => {
      const t = blob(c);
      if (looksDenied(t)) return `sibling grep denied: ${t.slice(0, 160)}`;
      if (looksShape(t)) return `shape: ${t.slice(0, 160)}`;
      return;
    },
  },
  {
    id: toolId("EditWorktree"),
    live: "Edit ~/.cursor/worktrees file (333 Edits)",
    name: "Edit",
    input: { file_path: worktreeFile, old_string: "export const n = 1;", new_string: "export const n = 2;" },
    expect: (c) => {
      const t = blob(c);
      if (looksDenied(t)) return `worktree edit denied: ${t.slice(0, 160)}`;
      if (looksShape(t)) return `shape: ${t.slice(0, 160)}`;
      return;
    },
  },
  {
    id: toolId("WriteTmp"),
    live: "Write /tmp scratch (163 Writes)",
    name: "Write",
    input: { file_path: tmpHabit, content: "tmp-habit\n" },
    expect: (c) => (looksDenied(blob(c)) ? `tmp write denied: ${blob(c).slice(0, 160)}` : undefined),
  },
  {
    id: toolId("WritePrivateTmp"),
    live: "Write /private/tmp (pwd -P alias of /tmp)",
    name: "Write",
    input: { file_path: privateTmp, content: "private-tmp-habit\n" },
    expect: (c) => (looksDenied(blob(c)) ? `private tmp denied: ${blob(c).slice(0, 160)}` : undefined),
  },
  {
    id: toolId("WriteSib"),
    live: "Write sibling checkout (105 Writes; 1 live PATH_DENIED before jail relax)",
    name: "Write",
    input: { file_path: join(sibling, "src", "out.py"), content: "print('out')\n" },
    expect: (c) => {
      const t = blob(c);
      if (looksDenied(t)) return `sibling write denied (jail tighter than current rule): ${t.slice(0, 160)}`;
      if (looksShape(t)) return `shape: ${t.slice(0, 160)}`;
      return;
    },
  },
  {
    id: toolId("WriteClaude"),
    live: "Write ~/.claude/projects/*/memory (18 Writes)",
    name: "Write",
    input: { file_path: join(claudeMem, "note.md"), content: "memory-updated\n" },
    expect: (c) => (looksDenied(blob(c)) ? `claude memory denied: ${blob(c).slice(0, 160)}` : undefined),
  },
  {
    id: toolId("ReadRefs"),
    live: "Read ~/.local/share/references-repos (7 Reads)",
    name: "Read",
    input: { file_path: join(refs, "x.rs") },
    expect: (c) => {
      const t = blob(c);
      if (looksDenied(t)) return `refs denied: ${t.slice(0, 160)}`;
      if (!t.includes("fn main")) return `unexpected: ${t.slice(0, 160)}`;
      return;
    },
  },
  {
    id: toolId("ReadDotdot"),
    live: "Read relative ../ (4 live Reads, all missing_file)",
    name: "Read",
    input: { file_path: "../nope-outside.txt" },
    expect: (c) => {
      const t = blob(c);
      if (looksDenied(t)) return;
      if (looksMissing(t)) return;
      return `relative ../ not denied or missing: ${t.slice(0, 160)}`;
    },
  },
  {
    id: toolId("BashCdAnd"),
    live: "Bash cd <cwd> && git status (2212 cd-and, 86 git)",
    name: "Bash",
    input: { command: `cd '${iso.project}' && git status --short` },
    expect: (c) => {
      const t = blob(c);
      if (!t.includes(REDUNDANT_CD_HINT) && !/not a git repository/i.test(t) && !/On branch|nothing to commit|^$/.test(t)) {
        return `cd-and git unexpected: ${t.slice(0, 180)}`;
      }
      return;
    },
  },
  {
    id: toolId("BashCdWorktree"),
    live: "Bash cd ~/.cursor/worktrees then pwd (scratch persist)",
    name: "Bash",
    input: { command: `cd '${worktree}' && pwd` },
    expect: (c) => {
      const t = blob(c);
      if (looksDenied(t)) return `cd worktree denied: ${t.slice(0, 160)}`;
      if (!t.includes("cc-mods-replay")) return `pwd not worktree: ${t.slice(0, 160)}`;
      return;
    },
  },
  {
    id: toolId("BashPwdAfter"),
    live: "next Bash pwd — cwd should stick after cd into scratch",
    name: "Bash",
    input: { command: "pwd" },
    expect: (c) => {
      const t = blob(c);
      if (!t.includes("cc-mods-replay")) return `cwd did not persist into worktree: ${t.slice(0, 180)}`;
      return;
    },
  },
  {
    id: toolId("BashCdTilde"),
    live: "Bash cd '~/…project' && printf (131 cd-tilde)",
    name: "Bash",
    input: { command: `cd '${projectTilde}' && printf tilde` },
    expect: (c) => {
      const t = blob(c);
      if (!t.includes("tilde")) return `cd-tilde failed: ${t.slice(0, 160)}`;
      return;
    },
  },
  {
    id: toolId("BashCdDotdot"),
    live: "Bash cd .. && pwd (73 cd-dotdot). Persist only if parent is a write root.",
    name: "Bash",
    input: { command: `cd '${iso.project}' && cd .. && pwd` },
    expect: (c) => {
      const t = blob(c);
      if (looksDenied(t)) return `cd-dotdot denied: ${t.slice(0, 160)}`;
      return;
    },
  },
  {
    id: toolId("BashCdTmp"),
    live: "Bash cd /tmp && printf (13 cd-tmp)",
    name: "Bash",
    input: { command: "cd /tmp && pwd && printf in-tmp" },
    expect: (c) => {
      const t = blob(c);
      if (!t.includes("in-tmp")) return `cd-tmp failed: ${t.slice(0, 160)}`;
      return;
    },
  },
  {
    id: toolId("BashCat"),
    live: "Bash cat → prefer Read (180 file-read)",
    name: "Bash",
    input: { command: `cat '${join(iso.tui, "hello.txt")}'` },
    expect: (c) => (/Use the Read tool/i.test(blob(c)) ? undefined : `not a Read prefer: ${blob(c).slice(0, 160)}`),
  },
  {
    id: toolId("BashFind"),
    live: "Bash find -name → prefer Glob (169 search)",
    name: "Bash",
    input: { command: `find '${iso.tui}' -name "*.md"` },
    expect: (c) => (/Use the Glob tool/i.test(blob(c)) ? undefined : `not a Glob prefer: ${blob(c).slice(0, 160)}`),
  },
  {
    id: toolId("BashEnv"),
    live: "Bash printenv TZ LANG TERM HOME — Mini face, not this laptop",
    name: "Bash",
    input: {
      command:
        "printf 'TZ=%s LANG=%s LC_ALL=%s TERM=%s HOME=%s CURSOR=%s AWS=%s Z=%s\\n' \"${TZ-}\" \"${LANG-}\" \"${LC_ALL-}\" \"${TERM-}\" \"${HOME-}\" \"${CURSOR_TRACE_ID-}\" \"${AWS_SECRET_ACCESS_KEY-}\" \"$(date +%z)\"",
    },
    expect: (c) => {
      const t = blob(c);
      if (!/TZ=Asia\/Tokyo/.test(t)) return `TZ not Mini: ${t.slice(0, 180)}`;
      if (!/LANG=en_US\.UTF-8/.test(t)) return `LANG not Mini: ${t.slice(0, 180)}`;
      if (!/TERM=xterm-256color/.test(t)) return `TERM not Mini: ${t.slice(0, 180)}`;
      if (!/Z=\+0900/.test(t)) return `date offset not JST: ${t.slice(0, 180)}`;
      if (/LC_ALL=\S/.test(t)) return `client LC_ALL leaked: ${t.slice(0, 180)}`;
      if (/\bAWS=AKIA|\bAWS=ASIA|\bAWS=\S{8,}/.test(t)) return `leaked AWS-like secret`;
      if (/CURSOR=\S+/.test(t) && !/CURSOR=$/.test(t) && !/CURSOR=\s/.test(t)) return `leaked CURSOR_ env: ${t.slice(0, 160)}`;
      return;
    },
  },
  {
    id: toolId("WriteThenBash"),
    live: "Write then Bash in one turn (58 Bash+Write parallel)",
    name: "Write",
    input: { file_path: join(iso.tui, "out.txt"), content: "wrote-then-bash\n" },
    expect: (c) => (looksDenied(blob(c)) ? `write half denied: ${blob(c).slice(0, 160)}` : undefined),
  },
  {
    id: toolId("BashAfterWrite"),
    live: "Bash half of Write+Bash turn",
    name: "Bash",
    input: { command: `printf after-write` },
    expect: (c) => (blob(c).includes("after-write") ? undefined : `bash half: ${blob(c).slice(0, 160)}`),
  },
  {
    id: toolId("ReplShell"),
    live: "REPL $`…` (753 of 1393). Print mode often has no REPL.",
    name: "REPL",
    input: { code: "$`printf repl-ok`" },
  },
  {
    id: toolId("PollWait"),
    live: "Poll after REPL (728 REPL>Poll). Builtin on Mini.",
    name: "Poll",
    input: {},
  },
  {
    id: toolId("ReadMiss"),
    live: "missing Read (22 missing_file). Must not look like permission denied.",
    name: "Read",
    input: { file_path: join(iso.tui, "gone.md") },
    expect: (c) => {
      const t = blob(c);
      if (looksDenied(t) && !looksMissing(t)) return "looks like permission denied";
      if (looksShape(t)) return `shape: ${t.slice(0, 160)}`;
      if (looksMissing(t)) return;
      return `unexpected missing Read: ${t.slice(0, 160)}`;
    },
  },
  {
    id: toolId("GrepEtc"),
    live: "Grep /etc (1 live PATH_DENIED other-abs)",
    name: "Grep",
    input: { pattern: "root", path: "/etc" },
    expect: (c) => (/PATH_DENIED/i.test(blob(c)) ? undefined : `etc grep not denied: ${blob(c).slice(0, 160)}`),
  },
  {
    id: toolId("GrepSingle"),
    live: "Grep single file with -C context (filenames must not contain line numbers or --)",
    name: "Grep",
    input: { pattern: "line-40", path: join(iso.tui, "src", "lib.ts"), output_mode: "content", "-C": 1 },
    expect: (c) => {
      const t = blob(c);
      if (looksDenied(t)) return `single-file grep denied: ${t.slice(0, 160)}`;
      if (!t.includes("lib.ts")) return `filename missing in single-file grep: ${t.slice(0, 180)}`;
      return;
    },
  },
  {
    id: toolId("ReadStale"),
    live: "missing Read when a stale file exists on Mini (must not leak Mini file)",
    name: "Read",
    input: { file_path: join(iso.tui, "stale-on-mini.txt") },
    expect: (c) => {
      const t = blob(c);
      if (t.includes("MINI_STALE_CONTENT")) return "leaked stale file from Mini";
      if (looksMissing(t)) return;
      return `unexpected stale Read: ${t.slice(0, 160)}`;
    },
  },
  {
    id: toolId("EditLarge"),
    live: "Edit >512 KiB file must stay under Mods join limit",
    name: "Edit",
    input: { file_path: join(iso.tui, "src", "large.txt"), old_string: "marker-line-0001\n", new_string: "marker-line-updated\n" },
    expect: (c) => {
      const t = blob(c);
      if (looksShape(t)) return `large edit hit join/shape: ${t.slice(0, 180)}`;
      if (looksDenied(t)) return `large edit denied: ${t.slice(0, 160)}`;
      if (!readFileSync(largeFile, "utf8").startsWith("marker-line-updated\n")) {
        return `large edit did not write on disk: ${t.slice(0, 160)}`;
      }
      return;
    },
  },
  {
    id: toolId("ReadSdk"),
    live: "Read/Grep read-only system header (/usr/include or /Applications) allowed; Write still denied",
    name: "Read",
    input: { file_path: "/usr/share/dict/words", offset: 1, limit: 3 },
    expect: (c) => {
      const t = blob(c);
      if (/PATH_DENIED/i.test(t)) return `read-only system dir denied: ${t.slice(0, 160)}`;
      return;
    },
  },
  {
    id: toolId("WriteSdk"),
    live: "Write into read-only toolchain root (/usr/share) still PATH_DENIED",
    name: "Write",
    input: { file_path: "/usr/share/cc-mods-replay-nope.txt", content: "nope\n" },
    expect: (c) => (/PATH_DENIED/i.test(blob(c)) ? undefined : `toolchain write not denied: ${blob(c).slice(0, 160)}`),
  },
  {
    id: toolId("BashDetachPipe"),
    live: "Bash `rm && nohup ... &` returns promptly instead of hanging on inherited pipes",
    name: "Bash",
    input: { command: `rm -f '${tmpHabit}.bg' && nohup bash -c "sleep 2; printf ok > '${tmpHabit}.bg'" >/dev/null 2>&1 &`, timeout: 5_000 },
    expect: (c) => {
      const t = blob(c);
      if (/timedOutAfterMs|running in background|run_in_background is not available/i.test(t)) {
        return `detached nohup auto-backgrounded or failed: ${t.slice(0, 160)}`;
      }
      return;
    },
  },
  {
    id: toolId("BashRgQuoted"),
    live: "Bash `rg -n \"fn foo|fn bar\"` keeps intact quoted pattern in prefer-Grep hint",
    name: "Bash",
    input: { command: `rg -n "line-1 |line-2 " '${join(iso.tui, "src", "lib.ts")}'` },
    expect: (c) => {
      const t = blob(c);
      if (!t.includes("pattern: line-1 |line-2 ")) return `pattern mangled: ${t.slice(0, 160)}`;
      return;
    },
  },
  {
    id: toolId("GrepMultiGlob"),
    live: "Grep space-separated glob (`*.ts *.md`) matches both extensions",
    name: "Grep",
    input: { pattern: "line-1|use bun", path: iso.tui, glob: "*.ts *.md" },
    expect: (c) => {
      const t = blob(c);
      if (!t.includes("lib.ts") || !t.includes("CLAUDE.md")) return `multi-glob missed: ${t.slice(0, 160)}`;
      return;
    },
  },
];

const grouped: Check[][] = [
  [checks[0]!, checks[1]!], // parallel Reads
  [checks[2]!, checks[3]!], // sibling Read+Grep
  [checks[4]!],
  [checks[5]!, checks[6]!], // tmp + private/tmp
  [checks[7]!],
  [checks[8]!],
  [checks[9]!],
  [checks[10]!],
  [checks[11]!],
  [checks[12]!],
  [checks[13]!],
  [checks[14]!],
  [checks[15]!],
  [checks[16]!],
  [checks[17]!, checks[18]!, checks[19]!], // cat/find/env
  [checks[20]!, checks[21]!], // Write+Bash
  [checks[22]!, checks[23]!], // REPL+Poll
  [checks[24]!],
  [checks[25]!],
  [checks[26]!],
  [checks[27]!],
  [checks[28]!],
  [checks[29]!, checks[30]!],
  [checks[31]!, checks[32]!, checks[33]!],
];

const turns: ScriptedTurn[] = [
  ...grouped.map((group) => ({
    blocks: group.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input })),
  })),
  { blocks: [{ type: "text", text: "coverage-done" }] },
];

const mock = startMockAnthropic(turns);
const relay = startRelay();
relay.bind("replay", iso.project, iso.tui);
const pluginDir = await stagePlugin({
  url: relay.url,
  token: relay.token,
  cwd: iso.project,
  tuiRoot: iso.tui,
});

const env = claudeEnv({
  mockUrl: mock.url,
  configDir: iso.config,
  extra: {
    [CODE_MODE_ENV]: "1",
    CC_MODS_TUI_ENV: JSON.stringify({
      TZ: "Asia/Tokyo",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      FORCE_COLOR: "3",
    }),
  },
});
acceptCodeModeCaveats(env, iso.config);

console.log("daily habits replay");
console.log("coverage", checks.length, "shapes in", grouped.length, "turns");
console.log("mock", mock.url);

const findings: { live: string; status: "ok" | "fail" | "watch"; detail: string }[] = [];

function cleanup(): void {
  for (const dir of [worktree, join(home, ".claude", "projects", "-cc-mods-replay"), refs, sibling, iso.root]) {
    if (dir.includes("cc-mods-replay") && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  for (const file of [tmpHabit, `${tmpHabit}.bg`, privateTmp]) {
    if (existsSync(file)) rmSync(file, { force: true });
  }
}

try {
  const ran = await runPrintClaude({
    bin,
    cwd: iso.tui,
    pluginDir,
    env,
    extraArgs: ["--tools", "Read,Write,Edit,Grep,Glob,Bash,REPL,Poll"],
    prompt: "Replay daily workspace-tool habits.",
    timeoutMs: 150_000,
  });
  console.log("claude exit", ran.code);
  if (ran.code !== 0) console.log("stderr tail\n", ran.stderr.slice(-2000));

  const results = mock.requests.flatMap((r) => toolResultsFromBody(r.body));
  for (const check of checks) {
    const hit = results.find((r) => r.toolUseId === check.id);
    if (!hit) {
      findings.push({ live: check.live, status: "fail", detail: "no tool_result in mock traffic" });
      continue;
    }
    const detail = check.expect?.(hit.content);
    const preview = blob(hit.content).replace(/\n/g, " ").slice(0, 180);
    if (!check.expect) {
      findings.push({ live: check.live, status: "watch", detail: preview });
      continue;
    }
    findings.push({ live: check.live, status: detail ? "fail" : "ok", detail: detail ?? preview });
  }

  const allText = mock.requests.map((r) => blob(r.body)).join("\n");
  if (/can't be joined/i.test(allText)) {
    findings.push({ live: "Mods join of huge { result }", status: "fail", detail: "join error still in API body" });
  }
  if (/The studio-ws-executor plugin sent a message/i.test(allText)) {
    findings.push({ live: "background notify origin", status: "fail", detail: "plugin-framed prompt" });
  }
  if (!ran.stdout.includes("coverage-done") && ran.code !== 0) {
    findings.push({ live: "session finished", status: "fail", detail: `claude exit ${ran.code}` });
  }

  const failed = findings.filter((f) => f.status === "fail");
  const watched = findings.filter((f) => f.status === "watch");
  for (const row of findings) {
    const tag = row.status === "ok" ? "ok" : row.status === "watch" ? "WATCH" : "FAIL";
    console.log(`${tag}  ${row.live}\n       ${row.detail.replace(/\n/g, " ").slice(0, 220)}`);
  }
  console.log(`${findings.length - failed.length - watched.length} ok, ${watched.length} watch, ${failed.length} fail`);
  if (failed.length) process.exitCode = 1;
} finally {
  mock.stop();
  relay.stop();
  cleanup();
}
