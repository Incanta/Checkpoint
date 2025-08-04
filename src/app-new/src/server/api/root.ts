import { postRouter } from "~/server/api/routers/post";
import { userRouter } from "~/server/api/routers/user";
import { authRouter } from "~/server/api/routers/auth";
import { orgRouter } from "~/server/api/routers/org";
import { repoRouter } from "~/server/api/routers/repo";
import { storageRouter } from "~/server/api/routers/storage";
import { branchRouter } from "~/server/api/routers/branch";
import { changelistRouter } from "~/server/api/routers/changelist";
import { createCallerFactory, createTRPCRouter } from "~/server/api/trpc";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  post: postRouter,
  user: userRouter,
  auth: authRouter,
  org: orgRouter,
  repo: repoRouter,
  storage: storageRouter,
  branch: branchRouter,
  changelist: changelistRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;

/**
 * Create a server-side caller for the tRPC API.
 * @example
 * const trpc = createCaller(createContext);
 * const res = await trpc.post.all();
 *       ^? Post[]
 */
export const createCaller = createCallerFactory(appRouter);
