/**
 * Live probe: SDK get_usage / getContextUsage on the SSH host.
 * Does not persist a session. Run: bun scripts/probe-usage.ts [--skip-behaviors] [--context]
 */
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

function silentPrompt(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  const ended = new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
    const end = () => resolve({ value: undefined, done: true });
    if (signal.aborted) end();
    else signal.addEventListener("abort", end, { once: true });
  });
  return { [Symbol.asyncIterator]: () => ({ next: () => ended }) };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function main() {
  const claude = process.env.CLAUDE_BIN ?? "claude";
  const skipBehaviors = process.argv.includes("--skip-behaviors");
  const alsoContext = process.argv.includes("--context");
  const stop = new AbortController();
  const started = Date.now();
  console.error(`[probe] claude=${claude} skipBehaviors=${skipBehaviors} context=${alsoContext}`);
  const q = query({
    prompt: silentPrompt(stop.signal),
    options: {
      pathToClaudeCodeExecutable: claude,
      settingSources: ["user"],
      settings: { disableAllHooks: true },
      strictMcpConfig: true,
      mcpServers: {},
      persistSession: false,
    },
  });
  try {
    const t0 = Date.now();
    const usage = await withTimeout(
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors }),
      60_000,
      "usage",
    );
    console.error(`[probe] usage ok in ${Date.now() - t0}ms`);
    console.log(JSON.stringify({ usage }, null, 2));
    if (alsoContext) {
      const t1 = Date.now();
      const context = await withTimeout(q.getContextUsage({ detail: "summary" }), 30_000, "context");
      console.error(`[probe] context ok in ${Date.now() - t1}ms`);
      console.log(JSON.stringify({ context }, null, 2));
    }
  } finally {
    try {
      q.close();
    } catch {
      /* ignore */
    }
    stop.abort();
    console.error(`[probe] done in ${Date.now() - started}ms`);
  }
}

await main();
