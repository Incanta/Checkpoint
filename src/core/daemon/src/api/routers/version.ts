import { publicProcedure, router } from "../trpc.js";
import {
  DAEMON_API,
  MIN_DAEMON_API,
  CLIENT_VERSION,
} from "../../api-version.js";
import { ApiVersionChecker } from "../../api-version-checker.js";

export const versionRouter = router({
  // Consumed by clients (cli/desktop/tray/unreal) connecting to this daemon.
  // Each client compares its own DAEMON_API >= minDaemonApi.
  check: publicProcedure.query(() => ({
    clientVersion: CLIENT_VERSION,
    daemonApi: DAEMON_API,
    minDaemonApi: MIN_DAEMON_API,
  })),

  // Per-server compatibility verdicts from the daemon's poll of every
  // connected app server. Used by the desktop UI to surface "this server
  // is too new for your daemon" warnings.
  appStatuses: publicProcedure.query(() => {
    return ApiVersionChecker.Get().getStatuses();
  }),
});
