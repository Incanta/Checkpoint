import net from "net";

/**
 * The daemon API is local-only. Every client (desktop, tray, CLI, VS Code,
 * and Unreal) connects to 127.0.0.1, so the server binds exactly that: a
 * wildcard bind would also be reachable from the network, and on Windows a
 * more specific 127.0.0.1 listener on the same port (another program, or
 * the daemon's own MCP server) would take the clients' connections from it.
 */
export const DAEMON_HOST = "127.0.0.1";

const MAX_ATTEMPTS = 100;

function tryListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once("error", () => resolve(false))
      .once("listening", () => {
        tester.close(() => resolve(true));
      })
      .listen(port, host);
  });
}

async function isPortAvailable(port: number): Promise<boolean> {
  const free0 = await tryListen(port, "0.0.0.0");
  if (!free0) return false;
  return tryListen(port, DAEMON_HOST);
}

/**
 * The first free port from `start` up, skipping `reserved` ones (the MCP
 * server's port, which may not be bound yet when the API starts).
 */
export async function findListenPort(
  start: number,
  reserved: number[] = [],
): Promise<number> {
  let port = start;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++, port++) {
    if (reserved.includes(port)) {
      console.log(`Port ${port} is reserved for MCP, trying ${port + 1}...`);
      continue;
    }
    if (await isPortAvailable(port)) {
      return port;
    }
    console.log(`Port ${port} is in use, trying ${port + 1}...`);
  }
  throw new Error(
    `Could not find an available port after ${MAX_ATTEMPTS} attempts`,
  );
}
