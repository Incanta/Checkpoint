import { router } from "./trpc";
import { authRouter } from "./routers/auth";
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import { GetDaemonListenPort } from "..";
import { workspaceRouter } from "./routers/workspace";

const appRouter = router({
  auth: authRouter,
  workspaces: workspaceRouter,
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
}
