import { userRouter } from "~/server/api/routers/user";
import { authRouter } from "~/server/api/routers/auth";
import { orgRouter } from "~/server/api/routers/org";
import { repoRouter } from "~/server/api/routers/repo";
import { storageRouter } from "~/server/api/routers/storage";
import { branchRouter } from "~/server/api/routers/branch";
import { changelistRouter } from "~/server/api/routers/changelist";
import { fileRouter } from "./routers/file";
import { apiTokenRouter } from "./routers/api-token";
import { createCallerFactory, createTRPCRouter } from "~/server/api/trpc";
import { workspaceRouter } from "./routers/workspace";
import { versionRouter } from "./routers/version";
import { labelRouter } from "./routers/label";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  user: userRouter,
  auth: authRouter,
  org: orgRouter,
  repo: repoRouter,
  storage: storageRouter,
  branch: branchRouter,
  changelist: changelistRouter,
  file: fileRouter,
  apiToken: apiTokenRouter,
  workspace: workspaceRouter,
  version: versionRouter,
  label: labelRouter,
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
