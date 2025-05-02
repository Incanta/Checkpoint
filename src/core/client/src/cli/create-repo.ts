import type { Command } from "commander";

export async function createRepoCommand(program: Command): Promise<void> {
  program
    .command("create-repo")
    .description("Create a new repository")
    .argument("<slug>", "Repository slug name (e.g. org/repo)")
    .action(async (slug) => {
      //
    })
}
