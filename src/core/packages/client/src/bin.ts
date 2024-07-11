import { program } from "commander";
import { getGitRoot } from "./util";
import { getConfig } from "./config";
import {
  InstallFilter,
  SetUpGitAttributes,
  Track,
  UpdateGitHooks,
} from "./git/setup";
import { PostCommitHook } from "./git/post-commit";
import { Clean } from "./filter/clean";
import { Smudge } from "./filter/smudge";

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
  .option("--skip-attributes", "Skip adding default .gitattributes")
  .option("-l, --log-level <level>", "Set the log level")
  .action(async (options) => {
    const config = await getConfig(await getGitRoot(process.cwd()));
    config.logging.level = options.logLevel || config.logging.level;

    if (options.skipAttributes !== true) {
      await SetUpGitAttributes(config);
    }

    await UpdateGitHooks(config, false);
  });

program
  .command("update")
  .description(
    "Install the Git hooks for Checkpoint in the current git repository"
  )
  .option("-l, --log-level <level>", "Set the log level")
  .option("-f, --force", "Force update the hooks")
  .action(async (options) => {
    const config = await getConfig(await getGitRoot(process.cwd()));
    config.logging.level = options.logLevel || config.logging.level;
    await UpdateGitHooks(config, options.force || false);
  });

program.command("post-commit", { hidden: true }).action(async () => {
  const config = await getConfig(await getGitRoot(process.cwd()));

  if (config.centralizedWorkflow) {
    const result = await PostCommitHook(config);
    process.exit(result);
  }
});

program
  .command("track")
  .description(
    "Track the provided pattern to be handled by Checkpoint instead of Git."
  )
  .argument("pattern")
  .option("-l, --log-level <level>", "Set the log level")
  .action(async (pattern, options) => {
    const config = await getConfig(await getGitRoot(process.cwd()));
    config.logging.level = options.logLevel || config.logging.level;

    await Track(config, pattern);
  });

program.command("filter-process", { hidden: true }).action(async (options) => {
  //
});

program
  .command("clean", { hidden: true })
  .argument("file")
  .action(async (file, options) => {
    const config = await getConfig(await getGitRoot(process.cwd()));
    await Clean(config, file);
  });

program
  .command("smudge", { hidden: true })
  .argument("file")
  .action(async (file, options) => {
    const config = await getConfig(await getGitRoot(process.cwd()));
    await Smudge(config, file);
  });

program.parse();
