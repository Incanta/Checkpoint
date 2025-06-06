import config from "@incanta/config";
import type { Command } from "commander";
import { promises as fs } from "fs";
import path from "path";
import { getAuthToken, type WorkspaceConfig } from "../util";
import { gql, GraphQLClient } from "graphql-request";
import inquirer from "inquirer";

export async function initCommand(program: Command): Promise<void> {
  program
    .command("init")
    .description("Initialize a Checkpoint workspace in the current directory")
    .argument("<name>", "Workspace name")
    .action(async (name) => {
      const workspace = process.cwd();
      const workspaceConfigDir = path.join(workspace, ".checkpoint");

      if (await fs.exists(workspaceConfigDir)) {
        console.error(
          `A Checkpoint workspace already exists in this directory.`
        );
        process.exit(1);
      }

      await fs.mkdir(workspaceConfigDir);

      const apiToken = await getAuthToken();

      const client = new GraphQLClient(
        config.get<string>("checkpoint.api.url"),
        {
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "auth-provider": "auth0",
          },
        }
      );

      const orgsResponse: any = await client.request(
        gql`
          query {
            myOrgs {
              id
              name
              repos {
                id
                name
              }
            }
          }
        `
      );

      const { org: selectedOrg } = await inquirer.prompt([
        {
          name: "org",
          type: "list",
          message: "Select an organization",
          choices: orgsResponse.myOrgs.map((org: any) => ({
            name: org.name,
            value: org.id,
          })),
        },
      ]);

      const { repo: selectedRepo } = await inquirer.prompt([
        {
          name: "repo",
          type: "list",
          message: "Select a repo",
          choices: orgsResponse.myOrgs
            .find((org: any) => org.id === selectedOrg)
            .repos.map((repo: any) => ({
              name: repo.name,
              value: repo.id,
            })),
        },
      ]);

      const workspaceDetails: WorkspaceConfig = {
        orgId: selectedOrg,
        repoId: selectedRepo,
        branchName: "main",
        workspaceName: name,
      };

      await fs.writeFile(
        path.join(workspaceConfigDir, "config.json"),
        JSON.stringify(workspaceDetails, null, 2)
      );

      console.log(
        `Initialized Checkpoint workspace; you need to manually run a pull command.`
      );
    });
}
