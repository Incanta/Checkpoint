import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import type { DaemonManager } from "../daemon-manager.js";

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
 * Export reusable router and procedure helpers
 * that can be used throughout the router
 */
export const router = t.router;
export const publicProcedure = t.procedure;
