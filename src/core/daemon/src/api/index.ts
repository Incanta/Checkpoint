import { router } from "./trpc.js";
import type { TRPCContext } from "./trpc.js";
import { authRouter } from "./routers/auth.js";
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import { workspacesRouter } from "./routers/workspace/index.js";
import { orgRouter } from "./routers/org.js";
import { repoRouter } from "./routers/repo.js";
import { jobsRouter } from "./routers/jobs.js";
import { updaterRouter } from "./routers/updater.js";
import net from "net";
import path from "path";
import { homedir } from "os";
import { promises as fs } from "fs";
import { DaemonManager } from "../daemon-manager.js";
import { DaemonConfig } from "../daemon-config.js";

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
});

// Export type router type signature,
// NOT the router itself.
export type AppRouter = typeof appRouter;

export async function InitApi(): Promise<void> {
  const server = createHTTPServer({
    router: appRouter,
    createContext: (): TRPCContext => ({
      manager: DaemonManager.Get(),
    }),
  });

  let listenPort = (await DaemonConfig.Get()).daemonPort;

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

  console.log(`Daemon server listening on port ${listenPort}`);
  console.log("[healthy] Daemon is ready");
}
