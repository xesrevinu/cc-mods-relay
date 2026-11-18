/**
 * Classify daily tool habits in local Claude JSONL.
 * Prints counts and command shapes only — no live homes, usernames, or session ids.
 *
 *   bun scripts/mine-jsonl-paths.ts
 */
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = join(homedir(), ".claude", "projects");
const HOME = homedir().replaceAll("\\", "/");

type Bucket =
  | "project"
  | "home-dot-cursor"
  | "home-dot-claude"
  | "home-dot-local"
  | "home-dot-ssh"
  | "home-workspace-sibling"
  | "home-other"
  | "tmp"
  | "private-tmp"
  | "var-tmp"
  | "var-folders"
  | "etc"
  | "usr"
  | "dev"
  | "relative-dotdot"
  | "tilde"
  | "dollar-home"
  | "other-abs";

function bucket(path: string): Bucket {
  const p = path.replaceAll("\\", "/");
  if (p.startsWith("../") || p === ".." || p.includes("/../")) return "relative-dotdot";
  if (p.startsWith("~/") || p === "~") return "tilde";
  if (p.startsWith("$HOME/") || p === "$HOME") return "dollar-home";
  if (p.startsWith("/tmp/") || p === "/tmp") return "tmp";
  if (p.startsWith("/private/tmp/") || p === "/private/tmp") return "private-tmp";
  if (p.startsWith("/var/tmp/") || p === "/var/tmp") return "var-tmp";
  if (p.startsWith("/var/folders/") || p.startsWith("/private/var/folders/")) return "var-folders";
  if (p.startsWith("/etc/") || p === "/etc") return "etc";
  if (p.startsWith("/usr/") || p === "/usr") return "usr";
  if (p.startsWith("/dev/") || p === "/dev") return "dev";
  if (p.startsWith(`${HOME}/.cursor`) || /\/Users\/[^/]+\/\.cursor/.test(p) || /\/home\/[^/]+\/\.cursor/.test(p)) {
    return "home-dot-cursor";
  }
  if (p.startsWith(`${HOME}/.claude`) || /\/Users\/[^/]+\/\.claude/.test(p) || /\/home\/[^/]+\/\.claude/.test(p)) {
    return "home-dot-claude";
  }
  if (p.startsWith(`${HOME}/.local`) || /\/Users\/[^/]+\/\.local/.test(p) || /\/home\/[^/]+\/\.local/.test(p)) {
    return "home-dot-local";
  }
  if (p.startsWith(`${HOME}/.ssh`) || /\/Users\/[^/]+\/\.ssh/.test(p) || /\/home\/[^/]+\/\.ssh/.test(p)) {
    return "home-dot-ssh";
  }
  if (/\/(Workspace|workspace)\/(github|src)\//.test(p)) return "home-workspace-sibling";
  if (p.startsWith(HOME) || /^\/Users\/[^/]+\//.test(p) || /^\/home\/[^/]+\//.test(p)) return "home-other";
  if (p.startsWith("/")) return "other-abs";
  return "project";
}

function pathFields(input: Record<string, unknown>): string[] {
  const keys = ["file_path", "path", "notebook_path", "target_directory", "cwd", "dir"];
  const out: string[] = [];
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string" && v.length > 0) out.push(v);
  }
  return out;
}

function failClass(text: string): string | undefined {
  const t = text.slice(0, 500);
  if (/PATH_DENIED/i.test(t)) return "PATH_DENIED";
  if (/File does not exist/i.test(t)) return "missing_file";
  if (/permission denied/i.test(t)) return "permission_denied";
  if (/can't be joined|shown it in parts/i.test(t)) return "hook_parts";
  if (/does not match its output shape/i.test(t)) return "shape";
  if (/overwrite a name that is already taken/i.test(t)) return "repl_redeclare";
  if (/Use the (Read|Glob|Grep) tool/i.test(t)) return "prefer_file";
  if (/toolDenialKind/i.test(t)) return "tool_denial";
  if (/No such tool available/i.test(t)) return "no_such_tool";
  if (/Waiting to be delivered/i.test(t)) return "notify_queued";
  return;
}

function bashKind(cmd: string): string {
  const c = cmd.trim();
  if (/^cd\b/.test(c)) {
    if (/\bcd\s+['"]?~/.test(c) || /\bcd\s+["']?\$HOME/.test(c)) return "cd-tilde";
    if (/\bcd\s+['"]?\.\./.test(c)) return "cd-dotdot";
    if (/\bcd\s+['"]?\/tmp/.test(c) || /\bcd\s+['"]?\/private\/tmp/.test(c)) return "cd-tmp";
    if (/\bcd\s+['"]?[^&;]+&&/.test(c)) return "cd-and";
    return "cd-only";
  }
  if (/\bnohup\b/.test(c) || /&\s*$/.test(c)) return "detach";
  if (/\bgit\b/.test(c)) return "git";
  if (/\bbun\b|\bnpm\b|\bpnpm\b|\byarn\b/.test(c)) return "js-pkg";
  if (/\b(python3?|uv|pip)\b/.test(c)) return "python";
  if (/\b(cargo|rustc|go)\b/.test(c)) return "systems";
  if (/^\s*(ls|pwd|whoami|uname|hostname|date|env|printenv|id)\b/.test(c)) return "env-probe";
  if (/^\s*(cat|sed|head|tail|wc)\b/.test(c)) return "file-read";
  if (/^\s*(find|rg|grep)\b/.test(c)) return "search";
  if (/^\s*(mkdir|cp|mv|rm|chmod|touch|ln)\b/.test(c)) return "fs-mutate";
  if (/\b(curl|wget|http)\b/.test(c)) return "http";
  if (/\b(ssh|scp)\b/.test(c)) return "ssh";
  if (/\bdocker\b/.test(c)) return "docker";
  if (/^\s*(sleep|wait)\b/.test(c)) return "wait";
  if (/^\s*(printf|echo)\b/.test(c)) return "echo";
  return "other";
}

function replKind(code: string): string {
  if (/\$`/.test(code) && /file\(/.test(code)) return "shell-and-file";
  if (/\$`/.test(code)) return "shell";
  if (/file\(/.test(code) && /write\(/.test(code)) return "file-and-write";
  if (/file\(/.test(code)) return "file";
  if (/write\(/.test(code)) return "write";
  if (/\bconst\b/.test(code)) return "const";
  return "other";
}

function cursorSub(path: string): string {
  const m = path.replaceAll("\\", "/").match(/\.cursor\/([^/]+)/);
  return m?.[1] ?? "other";
}

function claudeSub(path: string): string {
  const m = path.replaceAll("\\", "/").match(/\.claude\/([^/]+)/);
  return m?.[1] ?? "other";
}

function localSub(path: string): string {
  const m = path.replaceAll("\\", "/").match(/\.local\/share\/([^/]+)/);
  return m?.[1] ?? "other";
}

function top(map: Map<string, number>, n = 20): string[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k} ${v}`);
}

const toolCounts = new Map<string, number>();
const bucketCounts = new Map<string, number>();
const failCounts = new Map<string, number>();
const failBy = new Map<string, number>();
const toolByBucket = new Map<string, number>();
const bashKinds = new Map<string, number>();
const replKinds = new Map<string, number>();
const cursorSubs = new Map<string, number>();
const claudeSubs = new Map<string, number>();
const localSubs = new Map<string, number>();
const seqs = new Map<string, number>();
const parallel = new Map<string, number>();
const readOpts = new Map<string, number>();
const writeOpts = new Map<string, number>();
const pending = new Map<string, { name: string; bucket: string }>();
let files = 0;
let rows = 0;
let toolUses = 0;
let bgBash = 0;
let poll = 0;

const glob = new Bun.Glob("**/*.jsonl");
for await (const rel of glob.scan({ cwd: ROOT, onlyFiles: true })) {
  if (rel.includes("/agent-")) continue;
  files++;
  const raw = await Bun.file(join(ROOT, rel)).text();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    rows++;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = ev.message ?? ev;
    const content = msg?.content;
    if (!Array.isArray(content)) continue;
    const uses = content.filter((b: any) => b?.type === "tool_use" && typeof b.name === "string");
    if (uses.length) {
      const names = uses.map((b: any) => String(b.name).replace(/^mcp__(cc|workspace)__/, "inner-"));
      seqs.set(names.join(">"), (seqs.get(names.join(">")) ?? 0) + 1);
      if (uses.length > 1) {
        const set = [...new Set(names)].sort().join("+");
        parallel.set(set, (parallel.get(set) ?? 0) + 1);
      }
    }
    for (const block of content) {
      if (block?.type === "tool_use" && typeof block.name === "string") {
        toolUses++;
        const name = String(block.name);
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
        const input = block.input && typeof block.input === "object" ? (block.input as Record<string, unknown>) : {};
        const paths = pathFields(input);
        const b = paths.length ? bucket(paths[0]!) : "project";
        if (typeof block.id === "string") pending.set(block.id, { name, bucket: b });
        for (const p of paths) {
          const pb = bucket(p);
          bucketCounts.set(pb, (bucketCounts.get(pb) ?? 0) + 1);
          toolByBucket.set(`${name}:${pb}`, (toolByBucket.get(`${name}:${pb}`) ?? 0) + 1);
          if (pb === "home-dot-cursor") cursorSubs.set(cursorSub(p), (cursorSubs.get(cursorSub(p)) ?? 0) + 1);
          if (pb === "home-dot-claude") claudeSubs.set(claudeSub(p), (claudeSubs.get(claudeSub(p)) ?? 0) + 1);
          if (pb === "home-dot-local") localSubs.set(localSub(p), (localSubs.get(localSub(p)) ?? 0) + 1);
        }
        if (name === "Bash" || name.endsWith("__Bash")) {
          const cmd = typeof input.command === "string" ? input.command : "";
          bashKinds.set(bashKind(cmd), (bashKinds.get(bashKind(cmd)) ?? 0) + 1);
          if (input.run_in_background === true) bgBash++;
        }
        if (name === "REPL") {
          const code = typeof input.code === "string" ? input.code : "";
          replKinds.set(replKind(code), (replKinds.get(replKind(code)) ?? 0) + 1);
        }
        if (name === "Poll") poll++;
        if (name === "Read") {
          const key = [
            typeof input.offset === "number" ? "offset" : "no-offset",
            typeof input.limit === "number" ? "limit" : "no-limit",
          ].join("+");
          readOpts.set(key, (readOpts.get(key) ?? 0) + 1);
        }
        if (name === "Write" || name === "Edit") {
          writeOpts.set(name, (writeOpts.get(name) ?? 0) + 1);
        }
      }
      if (block?.type === "tool_result") {
        const t = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
        const fc = failClass(t);
        if (fc) {
          failCounts.set(fc, (failCounts.get(fc) ?? 0) + 1);
          const prev = typeof block.tool_use_id === "string" ? pending.get(block.tool_use_id) : undefined;
          if (prev) failBy.set(`${fc}:${prev.name}:${prev.bucket}`, (failBy.get(`${fc}:${prev.name}:${prev.bucket}`) ?? 0) + 1);
        }
      }
    }
  }
}

console.log("files", files, "rows", rows, "tool_use", toolUses);
console.log("tools\n", top(toolCounts, 18).join("\n "));
console.log("path buckets\n", top(bucketCounts, 20).join("\n "));
console.log("tool:bucket\n", top(toolByBucket, 25).join("\n "));
console.log("bash kinds\n", top(bashKinds, 20).join("\n "));
console.log("repl kinds\n", top(replKinds, 10).join("\n "));
console.log(".cursor subs\n", top(cursorSubs, 12).join("\n "));
console.log(".claude subs\n", top(claudeSubs, 12).join("\n "));
console.log(".local/share subs\n", top(localSubs, 8).join("\n "));
console.log("assistant seqs\n", top(seqs, 15).join("\n "));
console.log("parallel sets\n", top(parallel, 10).join("\n "));
console.log("read opts\n", top(readOpts, 8).join("\n "));
console.log("bg bash", bgBash, "poll", poll);
console.log("fail classes\n", top(failCounts, 15).join("\n "));
console.log("fail by tool:bucket\n", top(failBy, 20).join("\n "));
