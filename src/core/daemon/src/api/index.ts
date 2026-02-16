import { router } from "./trpc.js";
import { authRouter } from "./routers/auth.js";
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import { GetDaemonListenPort } from "../index.js";
import { workspaceRouter } from "./routers/workspace.js";
import { orgRouter } from "./routers/org.js";
import { repoRouter } from "./routers/repo.js";

const appRouter = router({
  auth: authRouter,
  workspaces: workspaceRouter,
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

  console.log(`Daemon server listening on port ${listenPort}`);
  console.log("[healthy] Daemon is ready");
}
