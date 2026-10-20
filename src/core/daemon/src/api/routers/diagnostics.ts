import { z } from "zod";
import path from "path";
import { homedir } from "os";
import { GetAllAuthConfigUsers } from "@checkpointvcs/common";
import { router, publicProcedure } from "../trpc.js";
import { DaemonConfig } from "../../daemon-config.js";
import { JobManager } from "../../job-manager.js";
import { ApiVersionChecker } from "../../api-version-checker.js";
import { getUpdater } from "../../updater.js";
import { McpManager } from "../../mcp-server.js";
import { Logger, ResolveLogFilePath } from "../../logging.js";
import { collectBugReport, redactFile } from "../../util/bug-report.js";

const BUNDLE_DIR = path.join(homedir(), ".checkpoint", "bug-reports");

/**
 * The tokens this daemon holds, so the bundle can scrub them wherever they
 * appear. Only the values are read; auth.json itself never goes in a bundle.
 */
async function knownSecrets(): Promise<string[]> {
  const secrets: string[] = [];
  try {
    for (const user of Object.values(await GetAllAuthConfigUsers())) {
      if (user?.apiToken) secrets.push(user.apiToken);
    }
  } catch {
    // No auth.json.
  }
  const envToken = process.env["CHECKPOINT_API_TOKEN"];
  if (envToken) secrets.push(envToken);
  return secrets;
}

export const diagnosticsRouter = router({
  /**
   * Collects a redacted log bundle (a zip) for a bug report and returns its
   * path. Clients add their own logs through `clientLogs` (the desktop app
   * sends its main-process log).
   */
  collectBugReport: publicProcedure
    .input(
      z
        .object({
          clientLogs: z
            .array(
              z.object({
                name: z.string().min(1).max(200),
                content: z.string().max(20 * 1024 * 1024),
              }),
            )
            .max(10)
            .optional(),
        })
        .optional(),
    )
    .mutation(async ({ ctx, input }) => {
      const config = await DaemonConfig.Get();
      let updater: unknown = null;
      try {
        updater = getUpdater().getStatus();
      } catch {
        // Not initialized in this process.
      }

      const result = await collectBugReport({
        config,
        logFilePath: ResolveLogFilePath(config),
        outputDir: BUNDLE_DIR,
        manager: ctx.manager,
        jobs: JobManager.Get().listJobs(),
        secrets: await knownSecrets(),
        clientLogs: input?.clientLogs,
        ephemeral: ctx.manager.ephemeral,
        status: {
          servers: ApiVersionChecker.Get().getStatuses(),
          updater,
          mcp: await McpManager.Get().getStatus(),
        },
      });
      Logger.info(`Wrote bug report bundle ${result.path}`);
      return result;
    }),

  /**
   * Writes a redacted copy of a file, such as `docker compose logs` output
   * from a self-hosted server, beside it (`<name>.redacted<ext>`) or to
   * `outputPath`. Returns the copy's path.
   */
  redactFile: publicProcedure
    .input(
      z.object({
        inputPath: z.string().min(1),
        outputPath: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      if (!path.isAbsolute(input.inputPath)) {
        throw new Error("inputPath must be absolute");
      }
      if (input.outputPath && !path.isAbsolute(input.outputPath)) {
        throw new Error("outputPath must be absolute");
      }
      return redactFile(input.inputPath, input.outputPath, {
        secrets: await knownSecrets(),
      });
    }),
});
