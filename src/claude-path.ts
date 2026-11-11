import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { reportImageVisionSmoke } from "./image-vision-smoke.js";

export const PROVENANCE_CLAUDE_VERSION = "2.1.312";

const INSTALL_HINT = 'Install the Claude Code subscription CLI or ensure "claude" is on PATH.';

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function parseClaudeVersion(output: string): string | null {
  const match = /(\d+\.\d+\.\d+)/.exec(output);
  return match ? match[1] : null;
}

export type VersionExec = (binPath: string, args: readonly string[]) => string;

function defaultVersionExec(binPath: string, args: readonly string[]): string {
  return execFileSync(binPath, [...args], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export function detectClaudeVersion(
  binPath: string,
  exec: VersionExec = defaultVersionExec,
): string | null {
  try {
    return parseClaudeVersion(exec(binPath, ["--version"]));
  } catch {
    return null;
  }
}

export function reportVersionDrift(
  detected: string | null,
  pinned: string,
  log: (...args: unknown[]) => void,
): void {
  if (detected !== null && detected !== pinned) {
    log(
      `[claude-path] claude version drift: detected ${detected} but provenance pins ${pinned} ` +
        `(continuing — drift is a warning, not a hard stop)`,
    );
  }
}

export interface ResolveOptions {
  detectVersion?: (binPath: string) => string | null;
  log?: (...args: unknown[]) => void;
}

export function resolveClaudePath(opts: ResolveOptions = {}): string {
  const pathEnv = process.env.PATH ?? "";
  const pathEntries = pathEnv.split(delimiter).filter((entry) => entry.length > 0);
  for (const entry of pathEntries) {
    const candidate = join(entry, "claude");
    if (isExecutable(candidate)) {
      const log = opts.log ?? console.error;
      try {
        const detected = (opts.detectVersion ?? detectClaudeVersion)(candidate);
        if (detected) {
          log(`[claude-path] resolved claude ${candidate} (version ${detected})`);
        }
        reportVersionDrift(detected, PROVENANCE_CLAUDE_VERSION, log);
        reportImageVisionSmoke(detected, log);
      } catch {
      }
      return candidate;
    }
  }

  throw new Error(
    `Could not resolve an executable "claude" binary. ` +
      `Tried: PATH lookup over ${pathEntries.length} entr${pathEntries.length === 1 ? "y" : "ies"} ` +
      `("${pathEnv}"). ${INSTALL_HINT}`,
  );
}
