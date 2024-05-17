import { program } from "commander";
import { UpdateGitHooks } from "./hooks";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require("../package.json");

program
  .name("Checkpoint CLI")
  .description("CLI for interfacing with Checkpoint")
  .version(packageJson.version);

program
  .command("install")
  .description("Install Checkpoint Git filters globally")
  .action(async () => {
    //
  });

program
  .command("update")
  .description(
    "Install the Git hooks for Checkpoint in the current git repository"
  )
  .action(async () => {
    await UpdateGitHooks(process.cwd());
  });

program.command("post-commit").action(() => {
  //
});

program.parse();
