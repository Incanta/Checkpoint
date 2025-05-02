import type { Command } from "commander";
import { promises as fs } from "fs";
import path from "path";
import { getWorkspaceDetails, getWorkspaceRoot } from "../util";
import { submit } from "../submit";
import type { LongtailLogLevel, Modification } from "common/src";

export async function submitCommand(program: Command): Promise<void> {
  program
    .command("submit")
    .aliases(["commit", "c", "s"])
    .description("Submit staged files")
    .requiredOption(
      "-m, --message <message>",
      "Changelist message; this must be the last option in the command line"
    )
    .option(
      "--longtail-log-level <level>",
      "Set the log level for the underlying longtail library (debug, info, warn, error, off)"
    )
    .action(
      async (options: {
        message: string;
        longtailLogLevel?: LongtailLogLevel;
      }) => {
        const workspace = await getWorkspaceRoot(process.cwd());
        const workspaceConfigDir = path.join(workspace, ".checkpoint");
        const stagedFile = path.join(workspaceConfigDir, "staged.json");

        const lockFile = path.join(workspaceConfigDir, "workspace.lock");
        if (await fs.exists(lockFile)) {
          console.error(
            `Workspace is locked by another client. If you are sure that is not the case, remove the lock file at ${lockFile}.`
          );
          process.exit(1);
        }

        let exitCode = 0;
        try {
          await fs.writeFile(lockFile, "");

          const stagedFiles: Modification[] = (await fs.exists(stagedFile))
            ? JSON.parse(await fs.readFile(stagedFile, "utf-8"))
            : [];

          if (stagedFiles.length === 0) {
            throw new Error("No files staged for commit.");
          }

          const workspaceDetails = await getWorkspaceDetails();

          await submit(
            workspaceDetails,
            options.message,
            stagedFiles,
            options.longtailLogLevel
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
          console.log("Successfully submitted changes.");
          await fs.rm(stagedFile);
        }

        process.exit(exitCode);
      }
    );
}
