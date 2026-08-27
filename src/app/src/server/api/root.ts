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
import { pullRequestRouter } from "./routers/pullRequest";
import { licenseRouter } from "./routers/license";
import { issueRouter } from "./routers/issue";
import { issueTrackerRouter } from "./routers/issue-tracker";
import { notificationRouter } from "./routers/notification";
import { shelfRouter } from "./routers/shelf";
import { artifactRouter } from "./routers/artifact";
import { gameSyncRouter } from "./routers/game-sync";
import { buildBadgeRouter } from "./routers/build-badge";
import { changelistReviewRouter } from "./routers/changelist-review";
import { emailRouter } from "./routers/email";
import { setupRouter } from "./routers/setup";
import { billingRouter } from "./routers/billing";
import { billingDevRouter } from "./routers/billing-dev";
import { adminRouter } from "./routers/admin";
import { inviteRouter } from "./routers/invite";

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
  pullRequest: pullRequestRouter,
  license: licenseRouter,
  issue: issueRouter,
  issueTracker: issueTrackerRouter,
  notification: notificationRouter,
  shelf: shelfRouter,
  artifact: artifactRouter,
  gameSync: gameSyncRouter,
  buildBadge: buildBadgeRouter,
  changelistReview: changelistReviewRouter,
  email: emailRouter,
  setup: setupRouter,
  billing: billingRouter,
  billingDev: billingDevRouter,
  admin: adminRouter,
  invite: inviteRouter,
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
