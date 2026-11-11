type Job = { kill: () => void; sessionId: string };

const jobs = new Map<string, Job>();
const cancelled = new Set<string>();

export function wasCancelled(callId: string | undefined): boolean {
  return Boolean(callId) && cancelled.has(callId!);
}

export function cancelCall(callId: string): void {
  if (!callId) return;
  cancelled.add(callId);
  jobs.get(callId)?.kill();
}

export function cancelSession(sessionId: string): void {
  if (!sessionId) return;
  for (const [id, job] of jobs) {
    if (job.sessionId === sessionId) cancelCall(id);
  }
}

export function registerJob(callId: string, sessionId: string, kill: () => void): void {
  if (!callId) return;
  jobs.set(callId, { kill, sessionId });
  if (cancelled.has(callId)) kill();
}

export function finishJob(callId: string): boolean {
  const hit = wasCancelled(callId);
  if (callId) {
    jobs.delete(callId);
    cancelled.delete(callId);
  }
  return hit;
}
