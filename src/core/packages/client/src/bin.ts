import { program } from "commander";
import { getGitRoot } from "./util";
import { DefaultConfig, getConfig } from "./config";
import { InstallFilter, SetUpGitAttributes, UpdateGitHooks } from "./git/setup";
import { PostCommitHook } from "./git/post-commit";

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
    await InstallFilter();
  });

program
  .command("init")
  .description(
    "Sets up the repository to use Checkpoint for common binary files"
  )
  .option(
    "-l, --log-level <level>",
    "Set the log level",
    DefaultConfig.logging.level
  )
  .action(async (options) => {
    const config = await getConfig(await getGitRoot(process.cwd()));
    config.logging.level = options.logLevel;

    await SetUpGitAttributes(config);

    await UpdateGitHooks(config, false);
  });

program
  .command("update")
  .description(
    "Install the Git hooks for Checkpoint in the current git repository"
  )
  .option(
    "-l, --log-level <level>",
    "Set the log level",
    DefaultConfig.logging.level
  )
  .option("-f, --force", "Force update the hooks")
  .action(async (options) => {
    const config = await getConfig(await getGitRoot(process.cwd()));
    config.logging.level = options.logLevel;
    await UpdateGitHooks(config, options.force || false);
  });

program.command("post-commit", { hidden: true }).action(async () => {
  const config = await getConfig(await getGitRoot(process.cwd()));
  const result = await PostCommitHook(config);
  process.exit(result);
});

program.parse();
