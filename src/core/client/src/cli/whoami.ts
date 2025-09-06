import type { Command } from "commander";
import { CreateApiClient } from "@checkpointvcs/common";

export async function whoamiCommand(program: Command): Promise<void> {
  program
    .command("whoami")
    .description("Check logged in user")
    .action(async () => {
      const client = await CreateApiClient();

      let meResponse: any;
      try {
        meResponse = await client.user.me.query();
      } catch (e: any) {
        console.log("Not logged in");
        process.exit(1);
      }

      if (!meResponse || !meResponse.id || !meResponse.email) {
        throw new Error("Could not get user information");
      }

      console.log(
        `You are logged in as ${meResponse.email} (${meResponse.id})`
      );
    });
}
