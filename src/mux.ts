import { ndJsonStream } from "@agentclientprotocol/sdk/unstable";

export type MuxKind = "acp" | "ctrl";

const encoder = new TextEncoder();

export function classify(msg: unknown): MuxKind | undefined {
  if (!msg || typeof msg !== "object") return undefined;
  const row = msg as { jsonrpc?: unknown; v?: unknown; type?: unknown };
  if (row.jsonrpc === "2.0") return "acp";
  if (row.v === 1 && typeof row.type === "string") return "ctrl";
  return undefined;
}

export function encodeNdjson(msg: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(msg)}\n`);
}

/** Byte duplex the ACP SDK's `ndJsonStream` can wrap. */
export function createAcpByteDuplex(send: (msg: unknown) => void) {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  let buffer = "";
  const decoder = new TextDecoder();

  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
        if (!line) continue;
        try {
          send(JSON.parse(line));
        } catch {
          /* drop malformed ACP line from the SDK */
        }
      }
    },
    close() {
      closed = true;
      try {
        controller?.close();
      } catch {
        /* already closed */
      }
    },
  });

  return {
    writable,
    readable,
    pushAcp(msg: unknown) {
      if (closed) return;
      controller?.enqueue(encodeNdjson(msg));
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        controller?.close();
      } catch {
        /* already closed */
      }
    },
  };
}

export function acpStreamFromWs(send: (msg: unknown) => void) {
  const duplex = createAcpByteDuplex(send);
  return {
    ...duplex,
    stream: ndJsonStream(duplex.writable, duplex.readable),
  };
}

export function parseWsJson(data: string | Buffer | ArrayBuffer): unknown {
  const text = typeof data === "string" ? data : Buffer.from(data as Buffer).toString();
  return JSON.parse(text);
}

/** Split NDJSON from a byte stream into JSON objects. */
export async function readNdjsonStream(
  input: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string | Buffer>,
  onObj: (msg: unknown) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  const feed = (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf("\n");
      if (!line) continue;
      try {
        onObj(JSON.parse(line));
      } catch {
        /* ignore malformed stdin line */
      }
    }
  };

  if (Symbol.asyncIterator in Object(input) && typeof (input as ReadableStream<Uint8Array>).getReader !== "function") {
    for await (const chunk of input as AsyncIterable<Uint8Array | string | Buffer>) {
      feed(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    }
    if (buffer.trim()) {
      try {
        onObj(JSON.parse(buffer.trim()));
      } catch {
        /* trailing fragment */
      }
    }
    return;
  }

  const reader = (input as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) feed(decoder.decode(value, { stream: true }));
  }
  if (buffer.trim()) {
    try {
      onObj(JSON.parse(buffer.trim()));
    } catch {
      /* trailing fragment */
    }
  }
}
