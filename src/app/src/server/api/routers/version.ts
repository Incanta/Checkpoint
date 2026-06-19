import { createTRPCRouter } from "~/server/api/trpc";
import { publicProcedure } from "~/server/api/trpc";
import { SERVER_API, MIN_SERVER_API, SERVER_VERSION } from "../api-version";

export const versionRouter = createTRPCRouter({
  current: publicProcedure.query(async () => {
    // Consumed by daemons connecting to this server to decide whether they
    // need to update. Daemon compares its own SERVER_API >= minServerApi.
    return {
      serverVersion: SERVER_VERSION,
      serverApi: SERVER_API,
      minServerApi: MIN_SERVER_API,
    };
  }),
});
