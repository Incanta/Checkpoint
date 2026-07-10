import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { McpManager } from "../../mcp-server.js";
import { DaemonConfig } from "../../daemon-config.js";

export const mcpRouter = router({
  getStatus: publicProcedure.query(async () => {
    return McpManager.Get().getStatus();
  }),

  setEnabled: publicProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      const config = DaemonConfig.Ensure();
      await DaemonConfig.Get(); // ensure loaded before mutating

      config.vars.mcp = {
        enabled: input.enabled,
        port: config.vars.mcp?.port ?? 13011,
      };
      await DaemonConfig.Save();

      // Apply immediately; no daemon restart required.
      if (input.enabled) {
        await McpManager.Get().start();
      } else {
        await McpManager.Get().stop();
      }

      return McpManager.Get().getStatus();
    }),
});
