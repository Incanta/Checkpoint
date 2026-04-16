import { publicProcedure, router } from "../trpc.js";
import {
  DAEMON_CLIENT_API_VERSION,
  DAEMON_MIN_CLIENT_VERSION,
  DAEMON_RECOMMENDED_CLIENT_VERSION,
} from "../../api-version.js";
import { ApiVersionChecker } from "../../api-version-checker.js";
import type { ApiVersionInfo } from "@checkpointvcs/common";

export const versionRouter = router({
  check: publicProcedure.query(
    (): ApiVersionInfo => ({
      currentVersion: DAEMON_CLIENT_API_VERSION,
      minimumVersion: DAEMON_MIN_CLIENT_VERSION,
      recommendedVersion: DAEMON_RECOMMENDED_CLIENT_VERSION,
    }),
  ),

  appStatuses: publicProcedure.query(() => {
    return ApiVersionChecker.Get().getStatuses();
  }),
});
