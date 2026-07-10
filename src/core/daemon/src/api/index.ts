import { router } from "./trpc.js";
import type { TRPCContext } from "./trpc.js";
import { authRouter } from "./routers/auth.js";
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import { workspacesRouter } from "./routers/workspace/index.js";
import { orgRouter } from "./routers/org.js";
import { repoRouter } from "./routers/repo.js";
import { jobsRouter } from "./routers/jobs.js";
import { updaterRouter } from "./routers/updater.js";
import { versionRouter } from "./routers/version.js";
import net from "net";
import path from "path";
import { homedir } from "os";
import { promises as fs } from "fs";
import { DaemonManager } from "../daemon-manager.js";
import { DaemonConfig } from "../daemon-config.js";
import { DAEMON_API, MIN_DAEMON_API } from "../api-version.js";

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
  const free127 = await tryListen(port, "127.0.0.1");
  return free127;
}

const appRouter = router({
  auth: authRouter,
  workspaces: workspacesRouter,
  orgs: orgRouter,
  repos: repoRouter,
  jobs: jobsRouter,
  updater: updaterRouter,
  version: versionRouter,
});

// Export type router type signature,
// NOT the router itself.
export type AppRouter = typeof appRouter;

export interface InitApiOptions {
  /**
   * Ephemeral mode: bind to an explicit/OS-assigned port, do NOT persist the
   * port to ~/.checkpoint/daemon.json (that file belongs to the resident
   * daemon), and write a handshake file so the spawning CLI can discover the
   * port reliably.
   */
  ephemeral?: boolean;
  /** Port to bind. In ephemeral mode 0 = OS-assigned. Ignored otherwise. */
  port?: number;
  /** Path to write the readiness handshake JSON in ephemeral mode. */
  handshakePath?: string;
}

/**
 * Starts the daemon HTTP/tRPC server. Returns the actual bound port.
 */
export async function InitApi(opts: InitApiOptions = {}): Promise<number> {
  const server = createHTTPServer({
    router: appRouter,
    createContext: (): TRPCContext => ({
      manager: DaemonManager.Get(),
    }),
  });

  let listenPort: number;

  if (opts.ephemeral) {
    // Bind exactly what was asked for (0 → OS picks a free ephemeral port).
    // No port scan and no writeback to the shared daemon.json.
    const requested = opts.port ?? 0;
    await new Promise<void>((resolve) => server.listen(requested, resolve));
    const address = server.address();
    listenPort =
      typeof address === "object" && address ? address.port : requested;
  } else {
    listenPort = (await DaemonConfig.Get()).daemonPort;

    const maxAttempts = 100;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (await isPortAvailable(listenPort)) {
        break;
      }
      console.log(`Port ${listenPort} is in use, trying ${listenPort + 1}...`);
      listenPort++;
      if (attempt === maxAttempts - 1) {
        throw new Error(
          `Could not find an available port after ${maxAttempts} attempts`,
        );
      }
    }

    await new Promise<void>((resolve) => server.listen(listenPort, resolve));

    DaemonConfig.Ensure().vars.daemonPort = listenPort;
    await DaemonConfig.Save();
  }

  if (opts.ephemeral && opts.handshakePath) {
    // Write atomically (temp + rename) so the CLI never reads a partial file.
    const handshake = JSON.stringify({
      pid: process.pid,
      port: listenPort,
      daemonApi: DAEMON_API,
      minDaemonApi: MIN_DAEMON_API,
      ready: true,
    });
    const tmpPath = `${opts.handshakePath}.tmp`;
    await fs.writeFile(tmpPath, handshake, "utf-8");
    await fs.rename(tmpPath, opts.handshakePath);
  }

  console.log(`Daemon server listening on port ${listenPort}`);
  console.log("[healthy] Daemon is ready");

  return listenPort;
}
