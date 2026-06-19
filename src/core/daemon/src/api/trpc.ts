import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { DaemonManager } from "../daemon-manager.js";
import { ApiVersionChecker } from "../api-version-checker.js";

export interface TRPCContext {
  manager: DaemonManager;
}

/**
 * Initialization of tRPC backend
 * Should be done only once per backend!
 */
const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
});

/**
 * Hard-block middleware: when any connected server reports the daemon below
 * its min_server_api (verdict from ApiVersionChecker), every procedure
 * returns FORBIDDEN — EXCEPT updater.* and version.*, which clients need to
 * recover from this state.
 *
 * The literal "update required" substring is matched by the CLI's top-level
 * catch (src/clients/cli/main.cpp) to render a friendlier prompt instead of a
 * raw error.
 */
const versionGateMiddleware = t.middleware(({ next, path }) => {
  const isExempt = path.startsWith("updater.") || path.startsWith("version.");
  if (!isExempt) {
    for (const status of ApiVersionChecker.Get().getStatuses()) {
      if (status.result.status === "incompatible") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `daemon below server's min_server_api; update required (${status.endpoint}: ${status.result.message})`,
        });
      }
    }
  }
  return next();
});

/**
 * Export reusable router and procedure helpers
 * that can be used throughout the router
 */
export const router = t.router;
export const publicProcedure = t.procedure.use(versionGateMiddleware);
