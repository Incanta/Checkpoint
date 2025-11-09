import { createTRPCRouter } from "~/server/api/trpc";
import { publicProcedure } from "~/server/api/trpc";

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-require-imports */
const packageJson: {
  version: string;
  minDesktopVersion: string;
} = require("../../../../package.json");
/* eslint-enable @typescript-eslint/no-require-imports */
/* eslint-enable @typescript-eslint/no-unsafe-assignment */

export const versionRouter = createTRPCRouter({
  current: publicProcedure.query(async ({ ctx }) => {
    return {
      version: packageJson.version,
      minDesktopVersion: packageJson.minDesktopVersion,
    };
  }),
});
