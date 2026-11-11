import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ModEvent = {
  type: string;
  [key: string]: unknown;
};

export type PermissionDecision = "allow_once" | "allow_with_updates" | "reject";

const POLL_MS = 20_000;

type Parked<T> = { hit: true; value: T } | { hit: false };
type Waiter<T> = { resolve: (parked: Parked<T>) => void; timer: ReturnType<typeof setTimeout> };

/**
 * Mini-local channel: Mods posts structured session events.
 * Prompts still go through herdr send-text / bun PTY write — not this socket.
 * GET /permission and GET /question park until the ACP client answers.
 */
export function startModChannel() {
  const dir = mkdtempSync(join(tmpdir(), "cc-mods-"));
  const path = join(dir, "mod.sock");
  let connected = false;
  const eventListeners = new Set<(event: ModEvent) => void>();
  const permissionAnswers = new Map<string, PermissionDecision>();
  const permissionWaiters = new Map<string, Waiter<PermissionDecision>>();
  const questionAnswers = new Map<string, Record<string, string> | null>();
  const questionWaiters = new Map<string, Waiter<Record<string, string> | null>>();

  function park<T>(store: Map<string, T>, waiters: Map<string, Waiter<T>>, id: string): Promise<Parked<T>> {
    if (store.has(id)) {
      const value = store.get(id)!;
      store.delete(id);
      return Promise.resolve({ hit: true, value });
    }
    const previous = waiters.get(id);
    if (previous) {
      clearTimeout(previous.timer);
      previous.resolve({ hit: false });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        resolve({ hit: false });
      }, POLL_MS);
      waiters.set(id, { resolve, timer });
    });
  }

  function fulfill<T>(store: Map<string, T>, waiters: Map<string, Waiter<T>>, id: string, value: T): void {
    const waiter = waiters.get(id);
    if (waiter) {
      waiters.delete(id);
      clearTimeout(waiter.timer);
      waiter.resolve({ hit: true, value });
      return;
    }
    store.set(id, value);
  }

  const server = Bun.serve({
    unix: path,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/hello") {
        connected = true;
        return Response.json({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/events") {
        connected = true;
        const body = (await req.json().catch(() => ({}))) as { events?: ModEvent[] };
        for (const event of body.events ?? []) {
          for (const listener of eventListeners) listener(event);
        }
        return Response.json({ ok: true });
      }
      if (req.method === "GET" && url.pathname === "/permission") {
        const id = url.searchParams.get("id") ?? "";
        const parked = await park(permissionAnswers, permissionWaiters, id);
        if (!parked.hit) return new Response(null, { status: 204 });
        return Response.json({ decision: parked.value });
      }
      if (req.method === "GET" && url.pathname === "/question") {
        const id = url.searchParams.get("id") ?? "";
        const parked = await park(questionAnswers, questionWaiters, id);
        if (!parked.hit) return new Response(null, { status: 204 });
        return Response.json({ answers: parked.value });
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    path,
    onEvent: (listener: (event: ModEvent) => void) => {
      eventListeners.add(listener);
      return () => { eventListeners.delete(listener); };
    },
    answerPermission(requestId: string, decision: PermissionDecision) {
      fulfill(permissionAnswers, permissionWaiters, requestId, decision);
    },
    answerQuestion(requestId: string, answers: Record<string, string> | null) {
      fulfill(questionAnswers, questionWaiters, requestId, answers);
    },
    get connected() {
      return connected;
    },
    stop() {
      connected = false;
      for (const waiter of permissionWaiters.values()) {
        clearTimeout(waiter.timer);
        waiter.resolve({ hit: false });
      }
      permissionWaiters.clear();
      for (const waiter of questionWaiters.values()) {
        clearTimeout(waiter.timer);
        waiter.resolve({ hit: false });
      }
      questionWaiters.clear();
      server.stop(true);
    },
  };
}

let active: ReturnType<typeof startModChannel> | undefined;

export function bindModChannel(channel: ReturnType<typeof startModChannel> | undefined): void {
  active = channel;
}

export function onModEvent(listener: (event: ModEvent) => void): () => void {
  return active?.onEvent(listener) ?? (() => {});
}

export function modChannelConnected(): boolean {
  return active?.connected === true;
}

export function answerPermission(requestId: string, decision: PermissionDecision): void {
  active?.answerPermission(requestId, decision);
}

export function answerQuestion(requestId: string, answers: Record<string, string> | null): void {
  active?.answerQuestion(requestId, answers);
}
