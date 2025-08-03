import config from "@incanta/config";
import type { Command } from "commander";
import { getAuthToken } from "../util";
import { createTRPCHTTPClient } from "@checkpointvcs/app-new/client";

export async function whoamiCommand(program: Command): Promise<void> {
  program
    .command("whoami")
    .description("Check logged in user")
    .action(async () => {
      const apiToken = await getAuthToken();

      const client = createTRPCHTTPClient({
        url: `${config.get<string>("checkpoint.api.url")}/api/trpc`,
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "auth-provider": "auth0",
        },
      });

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
