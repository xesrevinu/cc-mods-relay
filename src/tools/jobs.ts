type Job = { kill: () => void; sessionId: string; agentId?: string };

const CANCEL_ORPHAN_TTL_MS = 60_000;
const jobs = new Map<string, Job>();
const cancelled = new Set<string>();
const orphanTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

export function cancelSession(sessionId: string): void {
  if (!sessionId) return;
  for (const [id, job] of jobs) {
    if (job.sessionId === sessionId) cancelCall(id);
  }
}

export function cancelAgent(agentId: string): void {
  if (!agentId) return;
  for (const [id, job] of jobs) {
    if (job.agentId === agentId) cancelCall(id);
  }
}

export function registerJob(callId: string, sessionId: string, kill: () => void, agentId?: string): void {
  if (!callId) return;
  const prev = orphanTimers.get(callId);
  if (prev) {
    clearTimeout(prev);
    orphanTimers.delete(callId);
  }
  jobs.set(callId, { kill, sessionId, agentId });
  if (cancelled.has(callId)) kill();
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
