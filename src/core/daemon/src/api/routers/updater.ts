import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { getUpdater } from "../../updater.js";
import { DaemonManager } from "../../daemon-manager.js";

const updateChannel = z.enum(["release", "nightly"]);

export const updaterRouter = router({
  getStatus: publicProcedure.query(() => {
    return getUpdater().getStatus();
  }),

  checkNow: publicProcedure.mutation(async () => {
    return await getUpdater().checkForUpdates();
  }),

  /**
   * Switch delivery streams. Persists to daemon.json and re-checks straight
   * away so the caller gets the new channel's status back in one round trip.
   */
  setChannel: publicProcedure
    .input(z.object({ channel: updateChannel }))
    .mutation(async ({ input }) => {
      return await getUpdater().setChannel(input.channel);
    }),

  downloadUpdate: publicProcedure.mutation(async () => {
    const installerPath = await getUpdater().downloadUpdate();
    return { success: installerPath !== null, installerPath };
  }),

  applyUpdate: publicProcedure.mutation(async () => {
    // The installer stops this process. A pull it cut off would be
    // recovered on the next start, but there is no reason to cut one off.
    if (DaemonManager.Get().hasActiveVcsOperation()) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "A pull, submit, or merge is running. Install the update once it finishes.",
      });
    }
    await getUpdater().applyUpdate();
    return { success: true };
  }),
});
