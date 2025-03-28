import type { Command } from "commander";
import { promises as fs } from "fs";
import path from "path";
import { getWorkspaceRoot, relativePath } from "../util";
import type { Modification } from "common/src";

export async function statusCommand(program: Command): Promise<void> {
  program
    .command("status")
    .description("See the current status of the workspace")
    .action(async () => {
      const workspace = await getWorkspaceRoot(process.cwd());
      const workspaceConfigDir = path.join(workspace, ".checkpoint");

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

        const stagedFile = path.join(workspaceConfigDir, "staged.json");
        const stagedFiles: Modification[] = (await fs.exists(stagedFile))
          ? JSON.parse(await fs.readFile(stagedFile, "utf-8"))
          : [];

        if (stagedFiles.length === 0) {
          console.log("No files staged for commit.");
        } else {
          console.log("Staged files:");
          for (const file of stagedFiles) {
            const relative = relativePath(
              process.cwd(),
              path.join(workspace, file.path)
            );
            console.log(`  ${relative} ${file.delete ? "(deleted)" : ""}`);
          }
        }
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

      process.exit(exitCode);
    });
}
