import { createTRPCRouter } from "~/server/api/trpc";
import { publicProcedure } from "~/server/api/trpc";
import {
  APP_API_VERSION,
  APP_MIN_DAEMON_VERSION,
  APP_RECOMMENDED_DAEMON_VERSION,
} from "../api-version";

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
      apiVersion: APP_API_VERSION,
      minimumDaemonVersion: APP_MIN_DAEMON_VERSION,
      recommendedDaemonVersion: APP_RECOMMENDED_DAEMON_VERSION,
    };
  }),
});
