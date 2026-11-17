import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

export type BashIntent =
  | { action: "run"; command: string }
  | { action: "prefer"; tool: "Read" | "Grep" | "Glob" | "Edit"; message: string };

const CD_PREFIX = /^\s*cd\s+((?:"[^"]+"|'[^']+'|[^\s;&|]+))\s*(?:&&|;)\s*/;

function unquote(token: string): string {
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return token.slice(1, -1);
  }
  return token;
}

function sameDir(a: string, b: string): boolean {
  try {
    if (existsSync(a) && existsSync(b)) return realpathSync(a) === realpathSync(b);
  } catch {
    /* compare resolved paths */
  }
  return resolve(a) === resolve(b);
}

/** Drop `cd <cwd> &&` / `cd <cwd>;` when that directory is already the session cwd. */
export function stripRedundantCd(command: string, cwd: string): string {
  let rest = command;
  for (;;) {
    const hit = rest.match(CD_PREFIX);
    if (!hit) return rest;
    const dest = resolve(cwd, unquote(hit[1] ?? ""));
    if (!sameDir(dest, cwd)) return rest;
    rest = rest.slice(hit[0].length);
  }
}

/** Split on quote-aware `&&` / `;`. `||`, pipes, substitutions → undefined (keep Bash). */
function splitSequential(command: string): string[] | undefined {
  const stages: string[] = [];
  let cur = "";
  let quote: string | undefined;
  const push = () => {
    const part = cur.trim();
    if (part) stages.push(part);
    cur = "";
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\") {
      cur += ch + (command[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (ch === "`" || ch === "\n") return undefined;
    if (ch === "<" || ch === ">") return undefined;
    if (ch === "$" && command[i + 1] === "(") return undefined;
    if (ch === "|" && command[i + 1] === "|") return undefined;
    if (ch === "|") return undefined;
    if (ch === "&" && command[i + 1] === "&") {
      push();
      i += 1;
      continue;
    }
    if (ch === "&") return undefined;
    if (ch === ";") {
      push();
      continue;
    }
    cur += ch;
  }
  if (quote) return undefined;
  push();
  return stages.length ? stages : undefined;
}

function tokens(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function base(cmd: string): string {
  const name = cmd.split("/").pop() ?? cmd;
  return name;
}

const RG_OK = new Set([
  "-n",
  "-i",
  "-l",
  "-F",
  "-w",
  "--hidden",
  "--heading",
  "--no-heading",
  "--color=never",
  "--no-color",
  "--line-number",
  "--files-with-matches",
  "--fixed-strings",
]);
const RG_VALUE = new Set(["-e", "-g", "--glob", "--iglob", "-A", "-B", "-C", "-m", "-t", "--type"]);
const RG_EQ = ["--glob=", "--iglob=", "--type="];

function skipEnv(argv: string[]): string[] {
  let i = 0;
  while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]!)) i += 1;
  return argv.slice(i);
}

function ignorable(command: string): boolean {
  const argv = skipEnv(tokens(command));
  if (argv.length === 0) return true;
  const bin = base(argv[0]!);
  return bin === "true" || bin === ":" || bin === "pwd" || bin === "ls" || bin === "echo" || bin === "printf";
}

/** Drop stderr-discard so `rg foo 2>/dev/null` can still be Grep. */
function stripIgnorableRedirects(command: string): string {
  return command.replace(/\s+2>\s*\/dev\/null\b/g, "").trim();
}

function shellyPath(path: string): boolean {
  return /[*$`?]/.test(path) || /\$\{?/.test(path);
}

function looksLikePythonWrite(command: string): boolean {
  if (/open\s*\([^)]*['"]w/.test(command)) return true;
  if (/\.write_text\s*\(|\.write_bytes\s*\(/.test(command)) return true;
  return /open\s*\(/.test(command) && /\.write\s*\(/.test(command);
}

function sedInPlace(argv: string[]): boolean {
  return argv.slice(1).some(
    (t) => t === "-i" || t === "--in-place" || t.startsWith("--in-place=") || (t.startsWith("-i") && !t.startsWith("--")),
  );
}

function perlInPlace(argv: string[]): boolean {
  return argv.slice(1).some((t) => {
    if (t === "-i" || t === "--in-place" || t.startsWith("--in-place=")) return true;
    if (t.startsWith("-i") && !t.startsWith("--")) return true;
    const clustered = t.match(/^-([0-9aceflnprw]*)i(?:\..+)?$/);
    return Boolean(clustered);
  });
}

/** python/perl/sed in-place rewrites should be Edit; heredocs skip stage splitting and stay Bash. */
function preferMutation(command: string): Extract<BashIntent, { action: "prefer" }> | undefined {
  if (/\bperl\b/.test(command)) {
    const argv = skipEnv(tokens(command.replace(/<<[\s\S]*$/, "")));
    if (base(argv[0] ?? "") === "perl" && perlInPlace(argv)) {
      return { action: "prefer", tool: "Edit", message: "Use the Edit tool instead of perl -i." };
    }
  }
  if (/\bsed\b/.test(command) && /(^|\s)(-i\b|--in-place\b)/.test(command)) {
    const argv = skipEnv(tokens(command.replace(/<<[\s\S]*$/, "")));
    if (base(argv[0] ?? "") === "sed" && sedInPlace(argv)) {
      return { action: "prefer", tool: "Edit", message: "Use the Edit tool instead of sed -i." };
    }
  }
  if (/\bpython3?\b/.test(command) && looksLikePythonWrite(command)) {
    return { action: "prefer", tool: "Edit", message: "Use the Edit or Write tool instead of python to change files." };
  }
  return undefined;
}

function preferNative(command: string): Extract<BashIntent, { action: "prefer" }> | undefined {
  const argv = skipEnv(tokens(command));
  if (argv.length === 0) return undefined;
  const bin = base(argv[0]!);

  if (bin === "cat") {
    const files = argv.slice(1).filter((t) => t !== "-n" && t !== "--");
    if (files.length === 1 && !files[0]!.startsWith("-") && !shellyPath(files[0]!)) {
      return { action: "prefer", tool: "Read", message: `Use the Read tool with file_path: ${files[0]} instead of cat.` };
    }
    return undefined;
  }

  if (bin === "head") {
    let file: string | undefined;
    let skip = false;
    for (let i = 1; i < argv.length; i++) {
      const t = argv[i]!;
      if (t === "-n" && argv[i + 1]) {
        i += 1;
        continue;
      }
      if (/^-\d+$/.test(t) || t === "--") continue;
      if (t.startsWith("-")) {
        skip = true;
        break;
      }
      if (file) {
        skip = true;
        break;
      }
      file = t;
    }
    if (!skip && file && !shellyPath(file)) {
      return { action: "prefer", tool: "Read", message: `Use the Read tool with file_path: ${file} instead of head.` };
    }
    return undefined;
  }

  if (bin === "sed") {
    if (sedInPlace(argv)) {
      return { action: "prefer", tool: "Edit", message: "Use the Edit tool instead of sed -i." };
    }
    if (
      argv[1] === "-n" &&
      argv.length === 4 &&
      /^(\d+),(\d+)p$/.test(argv[2] ?? "") &&
      argv[3] &&
      !argv[3].startsWith("-") &&
      !shellyPath(argv[3])
    ) {
      return { action: "prefer", tool: "Read", message: `Use the Read tool with file_path: ${argv[3]} instead of sed.` };
    }
    return undefined;
  }

  if (bin === "rg" || bin === "grep") {
    let pattern: string | undefined;
    let glob: string | undefined;
    let skip = false;
    for (let i = 1; i < argv.length; i++) {
      const t = argv[i]!;
      if (t === "--") {
        pattern = argv[i + 1];
        break;
      }
      if (RG_VALUE.has(t)) {
        if (!argv[i + 1]) {
          skip = true;
          break;
        }
        if (t === "-g" || t === "--glob" || t === "--iglob") glob = argv[i + 1];
        i += 1;
        continue;
      }
      const eq = RG_EQ.find((p) => t.startsWith(p));
      if (eq) {
        if (eq === "--glob=" || eq === "--iglob=") glob = t.slice(eq.length);
        continue;
      }
      if (/^-[ABC]\d+$/.test(t) || /^-m\d+$/.test(t)) continue;
      if (RG_OK.has(t)) continue;
      if (t.startsWith("-")) {
        skip = true;
        break;
      }
      if (!pattern) {
        pattern = t;
        continue;
      }
    }
    if (!skip && pattern) {
      const globBit = glob ? ` glob: ${glob}` : "";
      return {
        action: "prefer",
        tool: "Grep",
        message: `Use the Grep tool with pattern: ${pattern}${globBit} instead of ${bin}.`,
      };
    }
    return undefined;
  }

  if (bin === "find") {
    let path = ".";
    let glob: string | undefined;
    let skip = false;
    for (let i = 1; i < argv.length; i++) {
      const t = argv[i]!;
      if (t === "-type" && argv[i + 1]) {
        i += 1;
        continue;
      }
      if (t === "-name" && argv[i + 1]) {
        glob = argv[i + 1];
        i += 1;
        continue;
      }
      if (t.startsWith("-")) {
        skip = true;
        break;
      }
      if (i === 1) path = t;
      else {
        skip = true;
        break;
      }
    }
    if (!skip && glob) {
      return {
        action: "prefer",
        tool: "Glob",
        message: `Use the Glob tool with pattern: ${glob} path: ${path} instead of find.`,
      };
    }
  }
  return undefined;
}

function joinPrefers(prefers: Extract<BashIntent, { action: "prefer" }>[]): BashIntent {
  if (prefers.length === 1) return prefers[0]!;
  const steps = prefers.map((p, i) => {
    const body = p.message.replace(/^Use the /, "").replace(/ instead of \S+\.$/, "");
    return i === 0 ? `Use the ${body}` : `then the ${body}`;
  });
  return {
    action: "prefer",
    tool: prefers[0]!.tool,
    message: `${steps.join("; ")}. Do not use Bash for this.`,
  };
}

/**
 * Before Bash spawn: drop a redundant `cd` onto the session cwd, then block
 * sequential cat/head/sed/rg/find that should be Read, Grep, or Glob.
 * Pipes, `||`, substitutions, and any non-native stage stay Bash.
 */
export function classifyBashIntent(command: string, cwd: string): BashIntent {
  const stripped = stripRedundantCd(stripIgnorableRedirects(command.trim()), cwd);
  if (!stripped) return { action: "run", command: "true" };
  const stages = splitSequential(stripped);
  if (!stages) return { action: "run", command: stripped };
  const prefers: Extract<BashIntent, { action: "prefer" }>[] = [];
  for (const stage of stages) {
    if (ignorable(stage)) continue;
    const mutate = preferMutation(stage);
    if (mutate) {
      prefers.push(mutate);
      continue;
    }
    const prefer = preferNative(stage);
    if (!prefer) return { action: "run", command: stripped };
    prefers.push(prefer);
  }
  if (prefers.length === 0) return { action: "run", command: stripped };
  return joinPrefers(prefers);
}
