import type { Command } from "commander";
import { promises as fs } from "fs";
import path from "path";
import { getWorkspaceRoot, relativePath } from "../util";
import type { Modification } from "@checkpointvcs/common";

export async function addCommand(program: Command): Promise<void> {
  program
    .command("add")
    .description("Stage files for commit")
    .arguments("<files...>")
    .action(async (files: string[]) => {
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

        const stagedFilesPaths = stagedFiles.map((f) => f.path);

        for (const file of files) {
          const filePath = path.join(process.cwd(), file);

          const exists = await fs.exists(filePath);
          const isDirectory = exists
            ? await fs.stat(filePath).then((s) => s.isDirectory())
            : false;

          if (isDirectory) {
            console.error(
              `Cannot stage directory ${file}. Only individual files can be staged.`
            );
            continue;
          }

          const relative = relativePath(workspace, filePath);

          if (!stagedFilesPaths.includes(relative)) {
            // TODO: need to check that if the file doesn't exist, it did before
            stagedFiles.push({
              path: relative,
              delete: !exists,
            });
          }
        }

        await fs.writeFile(stagedFile, JSON.stringify(stagedFiles, null, 2));
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
