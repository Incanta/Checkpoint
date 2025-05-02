import config from "@incanta/config";
import type { Command } from "commander";
import { getAuthToken } from "../util";
import { gql, GraphQLClient } from "graphql-request";

export async function whoamiCommand(program: Command): Promise<void> {
  program
    .command("whoami")
    .description("Check logged in user")
    .action(async () => {
      const apiToken = await getAuthToken();

      const client = new GraphQLClient(config.get<string>("checkpoint.api.url"), {
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "auth-provider": "auth0",
        },
      });

      let meResponse: any;
      try {
        meResponse = await client.request(
          gql`
            query {
              me {
                id
                email
              }
            }
          `
        );
      } catch (e: any) {
        console.log("Not logged in");
        process.exit(1);
      }

      if (!meResponse.me || !meResponse.me.id || !meResponse.me.email) {
        throw new Error("Could not get user information");
      }

      console.log(
        `You are logged in as ${meResponse.me.email} (${meResponse.me.id})`
      );
    })
}
