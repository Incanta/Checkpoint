import { program } from "commander";
import { loginCommand } from "./cli/login";
import { logoutCommand } from "./cli/logout";
import { addCommand } from "./cli/add";
import { rmCommand } from "./cli/rm";
import { statusCommand } from "./cli/status";
import { submitCommand } from "./cli/submit";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require("../package.json");

program
  .name("Checkpoint CLI")
  .description("CLI for interfacing with Checkpoint")
  .version(packageJson.version);

loginCommand(program);
logoutCommand(program);
addCommand(program);
rmCommand(program);
statusCommand(program);
submitCommand(program);

program.parse();
