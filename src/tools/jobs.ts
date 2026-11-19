type Job = { kill: () => void; sessionId: string; agentId?: string; background: boolean; outputFile?: string };

const CANCEL_ORPHAN_TTL_MS = 60_000;
const RECENT_OUTPUT_MAX = 200;
const jobs = new Map<string, Job>();
const recentOutputFiles = new Map<string, string>();
const cancelled = new Set<string>();
const orphanTimers = new Map<string, ReturnType<typeof setTimeout>>();

function rememberOutputFile(callId: string, outputFile?: string): void {
  if (!callId || !outputFile) return;
  if (recentOutputFiles.has(callId)) recentOutputFiles.delete(callId);
  if (recentOutputFiles.size >= RECENT_OUTPUT_MAX) {
    const oldest = recentOutputFiles.keys().next().value;
    if (oldest !== undefined) recentOutputFiles.delete(oldest);
  }
  recentOutputFiles.set(callId, outputFile);
}

function rememberCancel(callId: string): void {
  cancelled.add(callId);
  if (jobs.has(callId)) return;
  const prev = orphanTimers.get(callId);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    orphanTimers.delete(callId);
    if (!jobs.has(callId)) cancelled.delete(callId);
  }, CANCEL_ORPHAN_TTL_MS);
  timer.unref?.();
  orphanTimers.set(callId, timer);
}

export function wasCancelled(callId: string | undefined): boolean {
  return Boolean(callId) && cancelled.has(callId!);
}

export function cancelCall(callId: string): void {
  if (!callId) return;
  rememberCancel(callId);
  jobs.get(callId)?.kill();
}

export function cancelSession(sessionId: string, opts: { includeBackground?: boolean } = {}): void {
  if (!sessionId) return;
  const includeBackground = opts.includeBackground !== false;
  for (const [id, job] of jobs) {
    if (job.sessionId !== sessionId) continue;
    if (!includeBackground && job.background) continue;
    cancelCall(id);
  }
}

export function cancelAgent(agentId: string, opts: { includeBackground?: boolean } = {}): void {
  if (!agentId) return;
  const includeBackground = opts.includeBackground !== false;
  for (const [id, job] of jobs) {
    if (job.agentId !== agentId) continue;
    if (!includeBackground && job.background) continue;
    cancelCall(id);
  }
}

export function registerJob(
  callId: string,
  sessionId: string,
  kill: () => void,
  agentId?: string,
  opts: { background?: boolean; outputFile?: string } = {},
): void {
  if (!callId) return;
  const prev = orphanTimers.get(callId);
  if (prev) {
    clearTimeout(prev);
    orphanTimers.delete(callId);
  }
  jobs.set(callId, { kill, sessionId, agentId, background: opts.background === true, outputFile: opts.outputFile });
  rememberOutputFile(callId, opts.outputFile);
  if (cancelled.has(callId)) kill();
}

export function promoteJobToBackground(callId: string, outputFile?: string): void {
  if (!callId) return;
  const job = jobs.get(callId);
  if (!job) return;
  job.background = true;
  if (outputFile) {
    job.outputFile = outputFile;
    rememberOutputFile(callId, outputFile);
  }
}

export function getJobOutputFile(callId: string): string | undefined {
  if (!callId) return undefined;
  return jobs.get(callId)?.outputFile ?? recentOutputFiles.get(callId);
}

export function finishJob(callId: string): boolean {
  const hit = wasCancelled(callId);
  if (callId) {
    const prev = orphanTimers.get(callId);
    if (prev) {
      clearTimeout(prev);
      orphanTimers.delete(callId);
    }
    jobs.delete(callId);
    cancelled.delete(callId);
  }
  return hit;
}
