import type { Command } from "commander";

export async function loginCommand(program: Command): Promise<void> {
  program
    .command("login")
    .description("Login to Checkpoint")
    .action(async () => {
      console.log("Logging in...");

      // await AuthenticateDevice((code) => {
      //   console.log(`Authorize this device with code:\n${code}`);
      // });

      // const client = await CreateApiClient();

      // const meResponse = await client.user.me.query();

      // if (!meResponse) {
      //   throw new Error("Failed to get user information");
      // }

      // console.log(`Logged in as ${meResponse.email}`);
    });
}
