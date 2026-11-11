import { createInterface } from "node:readline";
import type { ChildProcess } from "node:child_process";

type Rpc = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

type Proc = {
  stdin: { write: (chunk: string) => unknown } | null;
  stdout: NodeJS.ReadableStream | ReadableStream<Uint8Array> | null;
  stderr?: NodeJS.ReadableStream | ReadableStream<Uint8Array> | null;
  kill: (signal?: NodeJS.Signals) => void;
  exited?: Promise<number>;
};

export class AcpTestClient {
  updates: Record<string, unknown>[] = [];
  permissions: unknown[] = [];
  stderr = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private closed = false;

  constructor(private readonly proc: Proc) {
    void this.readStdout();
    void this.readStderr();
  }

  static spawn(cmd: string[], opts: { cwd: string; env: Record<string, string> }): AcpTestClient {
    const proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      env: opts.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    return new AcpTestClient({
      stdin: proc.stdin as unknown as { write: (chunk: string) => unknown },
      stdout: proc.stdout as unknown as ReadableStream<Uint8Array>,
      stderr: proc.stderr as unknown as ReadableStream<Uint8Array>,
      kill: (signal) => proc.kill(signal),
      exited: proc.exited,
    });
  }

  static fromNode(child: ChildProcess): AcpTestClient {
    return new AcpTestClient({
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      kill: (signal) => child.kill(signal),
      exited: new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1))),
    });
  }

  async request<T>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    const id = this.nextId++;
    const reply = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms\nstderr:\n${this.stderr.slice(-4000)}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return reply as Promise<T>;
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  agentText(): string {
    return this.updates
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => {
        const content = u.content as { type?: string; text?: string } | undefined;
        return content?.type === "text" ? content.text ?? "" : "";
      })
      .join("");
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.proc.kill("SIGTERM");
    } catch {
    }
    await Promise.race([this.proc.exited ?? Bun.sleep(500), Bun.sleep(5_000)]);
    try {
      this.proc.kill("SIGKILL");
    } catch {
    }
  }

  private send(msg: Rpc): void {
    if (!this.proc.stdin) throw new Error("ACP client has no stdin");
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private reply(id: number | string, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  private onLine(line: string): void {
    let msg: Rpc;
    try {
      msg = JSON.parse(line) as Rpc;
    } catch {
      return;
    }
    if (msg.method === "session/update") {
      const params = msg.params as { update?: Record<string, unknown> };
      if (params?.update) this.updates.push(params.update);
      return;
    }
    if (msg.method === "session/request_permission" && msg.id !== undefined) {
      this.permissions.push(msg.params);
      const options = (msg.params as { options?: { optionId: string; kind: string }[] })?.options ?? [];
      const allow = options.find((o) => o.kind.startsWith("allow")) ?? options[0];
      this.reply(msg.id, { outcome: { outcome: "selected", optionId: allow?.optionId ?? "allow-once" } });
      return;
    }
    if (msg.method === "elicitation/create" && msg.id !== undefined) {
      this.reply(msg.id, { action: "cancel" });
      return;
    }
    if (msg.method && msg.id !== undefined) {
      this.reply(msg.id, {});
      return;
    }
    if (msg.id !== undefined && typeof msg.id === "number") {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(`${msg.error.message}${msg.error.data ? ` ${JSON.stringify(msg.error.data)}` : ""}\nstderr:\n${this.stderr.slice(-4000)}`));
      else pending.resolve(msg.result);
    }
  }

  private async readStdout(): Promise<void> {
    const stdout = this.proc.stdout;
    if (!stdout) return;
    if (isWebStream(stdout)) {
      const reader = stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line) this.onLine(line);
          }
        }
      } catch {
      }
      return;
    }
    for await (const line of createInterface({ input: stdout })) {
      if (line.trim()) this.onLine(line.trim());
    }
  }

  private async readStderr(): Promise<void> {
    const stderr = this.proc.stderr;
    if (!stderr) return;
    if (isWebStream(stderr)) {
      this.stderr += await new Response(stderr).text();
      return;
    }
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
  }
}

function isWebStream(stream: object): stream is ReadableStream<Uint8Array> {
  return "getReader" in stream && typeof (stream as ReadableStream).getReader === "function";
}
