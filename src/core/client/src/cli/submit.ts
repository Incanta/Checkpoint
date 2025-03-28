import config from "@incanta/config";
import type { Command } from "commander";
import { promises as fs } from "fs";
import path from "path";
import { getAuthToken, getWorkspaceDetails, getWorkspaceRoot } from "../util";
import { commit } from "../commit";
import type { Modification } from "common/src";
import { gql, GraphQLClient } from "graphql-request";

export async function submitCommand(program: Command): Promise<void> {
  program
    .command("submit")
    .aliases(["commit", "c", "s"])
    .description("Submit staged files")
    .requiredOption(
      "-m, --message <message>",
      "Changelist message; this must be the last option in the command line"
    )
    .action(async (options: { message: string }) => {
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

        const workspaceDetails = await getWorkspaceDetails();

        const storageTokenResponse: any = await client.request(
          gql`
            query getStorageToken(
              $orgId: String!
              $repoId: String!
              $write: Boolean!
            ) {
              storageToken(orgId: $orgId, repoId: $repoId, write: $write) {
                token
                expiration
                backendUrl
              }
            }
          `,
          {
            orgId: workspaceDetails.orgId,
            repoId: workspaceDetails.repoId,
            write: true,
          }
        );

        if (
          !storageTokenResponse.storageToken ||
          !storageTokenResponse.storageToken.token ||
          !storageTokenResponse.storageToken.expiration ||
          !storageTokenResponse.storageToken.backendUrl
        ) {
          throw new Error("Could not get storage token");
        }

        await commit(
          workspace,
          workspaceDetails.orgId,
          workspaceDetails.repoId,
          options.message,
          stagedFiles,
          storageTokenResponse.storageToken.token,
          storageTokenResponse.storageToken.expiration * 1000,
          storageTokenResponse.storageToken.backendUrl
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
    });
}
