/**
 * The daemon API's port choice (src/core/daemon/src/api/listen-port.ts).
 * Clients connect to 127.0.0.1 on the port in daemon.json, so when the
 * configured port is taken the daemon must land on a port where 127.0.0.1
 * reaches it, and never on the MCP server's port: on Windows the MCP
 * server's 127.0.0.1 listener on a shared port silently took every client
 * connection from a wildcard-bound daemon.
 */
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DAEMON_HOST,
  findListenPort,
} from "../../../core/daemon/src/api/listen-port.js";

const open: net.Server[] = [];

function listen(port: number, host: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, host, () => {
      open.push(server);
      resolve(server);
    });
  });
}

function portOf(server: net.Server): number {
  return (server.address() as net.AddressInfo).port;
}

/** A port with `count` free ports after it, found by asking the OS. */
async function freeRun(count: number): Promise<number> {
  for (;;) {
    const probe = await listen(0, DAEMON_HOST);
    const start = portOf(probe);
    await close(probe);
    if (start + count > 65535) continue;
    const held: net.Server[] = [];
    try {
      for (let p = start; p < start + count; p++) {
        held.push(await listen(p, DAEMON_HOST));
      }
      await Promise.all(held.map(close));
      return start;
    } catch {
      await Promise.all(held.map(close));
    }
  }
}

function close(server: net.Server): Promise<void> {
  open.splice(open.indexOf(server), 1);
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("the daemon's listen port", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([...open].map(close));
  });

  it("keeps the configured port when it is free", async () => {
    const start = await freeRun(2);
    expect(await findListenPort(start, [start + 1])).toBe(start);
  });

  it("moves past a port another program holds on 127.0.0.1", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const start = await freeRun(3);
    await listen(start, DAEMON_HOST);
    expect(await findListenPort(start, [])).toBe(start + 1);
  });

  it("moves past a port another program holds on all interfaces", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const start = await freeRun(3);
    await listen(start, "0.0.0.0");
    expect(await findListenPort(start, [])).toBe(start + 1);
  });

  it("skips the MCP port even before the MCP server has bound it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const start = await freeRun(3);
    await listen(start, DAEMON_HOST);
    expect(await findListenPort(start, [start + 1])).toBe(start + 2);
  });

  it("a server bound to the chosen port answers clients on 127.0.0.1", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const start = await freeRun(3);
    await listen(start, DAEMON_HOST);
    const port = await findListenPort(start, [start + 1]);
    const daemon = await listen(port, DAEMON_HOST);
    daemon.on("connection", (socket) => socket.end("daemon"));

    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1");
      let data = "";
      socket.on("data", (chunk) => (data += chunk));
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    expect(reply).toBe("daemon");
  });

  it("then leaves no room for a second 127.0.0.1 listener on that port", async () => {
    const start = await freeRun(1);
    await listen(start, DAEMON_HOST);
    await expect(listen(start, DAEMON_HOST)).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
  });
});
