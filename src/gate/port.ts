import { createServer } from "node:net";

export const DEFAULT_PORT_ATTEMPTS = 10;

export const LOOPBACK_HOST = "127.0.0.1";

export interface PortServer {
  listen(port: number, host: string): void;
  close(cb?: () => void): void;
  address(): { port: number } | string | null;
  once(event: "listening" | "error", cb: (...args: unknown[]) => void): void;
  removeListener(event: "listening" | "error", cb: (...args: unknown[]) => void): void;
}

export type ServerFactory = () => PortServer;

const defaultServerFactory: ServerFactory = () => createServer() as unknown as PortServer;

function listenOnce(makeServer: ServerFactory, host: string, port: number): Promise<PortServer> {
  return new Promise((resolve, reject) => {
    const server = makeServer();
    const onError = (...args: unknown[]) => {
      server.removeListener("listening", onListening);
      try {
        server.close();
      } catch {
      }
      reject((args[0] as NodeJS.ErrnoException) ?? new Error("listen failed"));
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeQuietly(server: PortServer): Promise<void> {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

export async function findFreePort(
  attempts: number = DEFAULT_PORT_ATTEMPTS,
  makeServer: ServerFactory = defaultServerFactory,
): Promise<number> {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`findFreePort: attempts must be a positive integer, got ${String(attempts)}`);
  }

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let probe: PortServer;
    try {
      probe = await listenOnce(makeServer, LOOPBACK_HOST, 0);
    } catch (err) {
      lastError = err;
      continue;
    }
    const address = probe.address();
    if (address === null || typeof address === "string") {
      lastError = new Error("findFreePort: OS-assigned listener returned no numeric port");
      await closeQuietly(probe);
      continue;
    }
    const candidate = address.port;
    await closeQuietly(probe);

    let verify: PortServer;
    try {
      verify = await listenOnce(makeServer, LOOPBACK_HOST, candidate);
    } catch (err) {
      lastError = err;
      continue;
    }
    await closeQuietly(verify);
    return candidate;
  }

  const detail =
    lastError instanceof Error
      ? `${lastError.message}`
      : lastError === null
        ? "no candidate could be OS-assigned"
        : String(lastError);
  throw new Error(
    `findFreePort: could not obtain a verified-free 127.0.0.1 port after ${attempts} attempt(s); ` +
      `last bind error: ${detail}. Refusing to return an unverified port (global port-in-use rule).`,
  );
}
