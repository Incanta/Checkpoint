import type { Command } from "commander";
import { existsSync, promises as fs } from "fs";
import path from "path";
import { getWorkspaceRoot, relativePath } from "../util";
import type { Modification } from "common/src";

export async function rmCommand(program: Command): Promise<void> {
  program
    .command("rm")
    .description("Unstage files for commit")
    .arguments("<files...>")
    .action(async (files: string[]) => {
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

        const stagedFile = path.join(workspaceConfigDir, "staged.json");
        let stagedFiles: Modification[] = existsSync(stagedFile)
          ? JSON.parse(await fs.readFile(stagedFile, "utf-8"))
          : [];

        const relativeFiles = files.map((file) =>
          relativePath(workspace, path.join(process.cwd(), file)),
        );

        stagedFiles = stagedFiles.filter(
          (f) => !relativeFiles.includes(f.path),
        );

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
