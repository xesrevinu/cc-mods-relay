import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";

interface ModelGeneration {
  family: string;
  version: number[];
}

const WIRE_ID = /claude-([a-z]+)-(\d+(?:-\d+)*)/i;

const CONTEXT_HINT = /\[\dm\]|-\dm\b/gi;

export function modelGeneration(info: ModelInfo): ModelGeneration | null {
  const id = (info.resolvedModel ?? info.value ?? "").replace(CONTEXT_HINT, "");
  const match = WIRE_ID.exec(id);
  if (!match) return null;
  const version = match[2].split("-").slice(0, 2).map(Number);
  if (version.some((part) => !Number.isFinite(part))) return null;
  return { family: match[1].toLowerCase(), version };
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function filterSupersededModels(infos: ModelInfo[]): ModelInfo[] {
  const newest = new Map<string, number[]>();
  for (const info of infos) {
    const generation = modelGeneration(info);
    if (!generation) continue;
    const best = newest.get(generation.family);
    if (!best || compareVersions(generation.version, best) > 0) {
      newest.set(generation.family, generation.version);
    }
  }
  return infos.filter((info) => {
    const generation = modelGeneration(info);
    if (!generation) return true;
    const best = newest.get(generation.family);
    return !best || compareVersions(generation.version, best) === 0;
  });
}
