import { router } from "./trpc.js";
import { authRouter } from "./routers/auth.js";
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import { GetDaemonListenPort } from "../index.js";
import { workspacesRouter } from "./routers/workspace/index.js";
import { orgRouter } from "./routers/org.js";
import { repoRouter } from "./routers/repo.js";
import path from "path";
import { homedir } from "os";
import { promises as fs } from "fs";

const appRouter = router({
  auth: authRouter,
  workspaces: workspacesRouter,
  orgs: orgRouter,
  repos: repoRouter,
});

// Export type router type signature,
// NOT the router itself.
export type AppRouter = typeof appRouter;

export async function InitApi(): Promise<void> {
  const server = createHTTPServer({
    router: appRouter,
  });

  const listenPort = await GetDaemonListenPort();

  await new Promise<void>((resolve) => server.listen(listenPort, resolve));

  const configFilePath = path.join(homedir(), ".checkpoint", "daemon.json");

  let daemonConfig: any = {};
  try {
    const configStr = await fs.readFile(configFilePath, "utf-8");
    daemonConfig = JSON.parse(configStr);
  } catch (e: any) {
    //
  }

  daemonConfig.daemonPort = listenPort;

  try {
    await fs.mkdir(path.dirname(configFilePath), { recursive: true });
    await fs.writeFile(
      configFilePath,
      JSON.stringify(daemonConfig, null, 2),
      "utf-8",
    );
  } catch (e: any) {
    console.error("Failed to write daemon config file:", e);
  }

  console.log(`Daemon server listening on port ${listenPort}`);
  console.log("[healthy] Daemon is ready");
}
