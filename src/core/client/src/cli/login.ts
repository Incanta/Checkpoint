import config from "@incanta/config";
import type { Command } from "commander";
import open from "open";
import { URLSearchParams } from "url";
import { gql, GraphQLClient } from "graphql-request";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

export async function loginCommand(program: Command): Promise<void> {
  program
    .command("login")
    .description("Login to Checkpoint")
    .action(async () => {
      console.log("Logging in...");

      const authResponse = await fetch(
        `${config.get<string>("auth.auth0.url")}/oauth/device/code`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: config.get<string>("auth.auth0.client-id"),
            audience: config.get<string>("auth.auth0.audience-api"),
            scope: "openid profile email", // TODO
          }),
        }
      ).then((res) => {
        return res.json();
      });

      console.log(
        `Confirm this authentication code in your browser:\n\n${authResponse.user_code}\n`
      );

      await open(authResponse.verification_uri_complete);

      const expiration = Date.now() + authResponse.expires_in * 1000;

      let tokenBody: {
        access_token: string;
        refresh_token?: string;
        id_token?: string;
        token_type: string;
        expires_in: number;
      };

      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (Date.now() > expiration) {
          throw new Error("Login expired");
        }

        const responseBody = await fetch(
          `${config.get<string>("auth.auth0.url")}/oauth/token`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              client_id: config.get<string>("auth.auth0.client-id"),
              device_code: authResponse.device_code,
            }),
          }
        ).then((res) => {
          return res.json();
        });

        if (responseBody.error) {
          if (responseBody.error === "expired_token") {
            throw new Error("Login expired");
          }

          await new Promise<void>((resolve) =>
            setTimeout(resolve, authResponse.interval * 1000)
          );
        } else {
          tokenBody = responseBody;
          break;
        }
      }

      await fs.mkdir(path.join(os.homedir(), ".config", "checkpoint"), {
        recursive: true,
      });

      await fs.writeFile(
        path.join(os.homedir(), ".config", "checkpoint", "auth.json"),
        JSON.stringify(tokenBody)
      );

      const client = new GraphQLClient(
        config.get<string>("checkpoint.api.url"),
        {
          headers: {
            Authorization: `Bearer ${tokenBody.access_token}`,
            "auth-provider": "auth0",
          },
        }
      );

      const meResponse: any = await client.request(
        gql`
          query {
            me {
              email
            }
          }
        `
      );

      if (!meResponse?.me) {
        throw new Error("Failed to get user information");
      }

      console.log(`Logged in as ${meResponse.me.email}`);
    });
}
