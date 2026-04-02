import { router, publicProcedure } from "../trpc.js";
import { getUpdater } from "../../updater.js";

export const updaterRouter = router({
  getStatus: publicProcedure.query(() => {
    return getUpdater().getStatus();
  }),

  checkNow: publicProcedure.mutation(async () => {
    return await getUpdater().checkForUpdates();
  }),

  downloadUpdate: publicProcedure.mutation(async () => {
    const installerPath = await getUpdater().downloadUpdate();
    return { success: installerPath !== null, installerPath };
  }),

  applyUpdate: publicProcedure.mutation(async () => {
    await getUpdater().applyUpdate();
    return { success: true };
  }),
});
