import type { Command } from "commander";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

export async function logoutCommand(program: Command): Promise<void> {
  program
    .command("logout")
    .description("Logout from Checkpoint")
    .action(async () => {
      await fs.rm(
        path.join(os.homedir(), ".config", "checkpoint", "auth.json")
      );

      console.log(`Logged out.`);
    });
}
