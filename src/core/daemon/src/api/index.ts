import { router } from "./trpc";
import { authRouter } from "./routers/auth";
import { createHTTPServer } from "@trpc/server/adapters/standalone";

const appRouter = router({
  auth: authRouter,
});

// Export type router type signature,
// NOT the router itself.
export type AppRouter = typeof appRouter;

const server = createHTTPServer({
  router: appRouter,
});

server.listen(3000);
