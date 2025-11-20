import type { Command } from "commander";
import { existsSync, promises as fs } from "fs";
import path from "path";
import { getWorkspaceDetails, getWorkspaceRoot } from "../util";
import { pull } from "../pull";
import type { LongtailLogLevel } from "common/src";

export async function pullCommand(program: Command): Promise<void> {
  program
    .command("pull")
    .aliases(["sync", "p"])
    .option(
      "-c, --changelist <cl>",
      "Pull a specific changelist number (default: latest)",
      "latest",
    )
    .option(
      "--longtail-log-level <level>",
      "Set the log level for the underlying longtail library (debug, info, warn, error, off)",
    )
    .description("Pull latest files")
    .action(
      async (options: {
        changelist: string;
        longtailLogLevel?: LongtailLogLevel;
      }) => {
        const workspace = await getWorkspaceRoot(process.cwd());
        const workspaceConfigDir = path.join(workspace, ".checkpoint");

        const lockFile = path.join(workspaceConfigDir, "workspace.lock");
        if (existsSync(lockFile)) {
          console.error(
            `Workspace is locked by another client. If you are sure that is not the case, remove the lock file at ${lockFile}.`,
          );
          process.exit(1);
        }

        let exitCode = 0;
        try {
          await fs.writeFile(lockFile, "");

          const workspaceDetails = await getWorkspaceDetails();

          if (
            options.changelist !== "latest" &&
            isNaN(Number(options.changelist))
          ) {
            console.error(
              `Invalid changelist number: ${options.changelist}. Please provide a valid number or use "latest".`,
            );
            process.exit(1);
          }

          const getLatest = options.changelist === "latest";

          await pull(
            workspaceDetails,
            "TODO orgID",
            getLatest ? null : Math.floor(Number(options.changelist)),
            null,
            options.longtailLogLevel,
          );
        } catch (e: any) {
          if (e.message) {
            console.error(e.message);
          } else {
            console.error(JSON.stringify(e));
          }
          exitCode = 1;
        } finally {
          await fs.rm(lockFile);
        }

        if (exitCode === 0) {
          console.log("Successfully pulled changes.");
        }

        process.exit(exitCode);
      },
    );
}
