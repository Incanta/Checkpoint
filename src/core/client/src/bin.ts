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

const args = process.argv;
const adjustedArgs: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (
    args[i] === "submit" ||
    args[i] === "commit" ||
    args[i] === "c" ||
    args[i] === "s"
  ) {
    adjustedArgs.push("submit");
    i++;
    if (args[i] === "-m" || args[i] === "--message") {
      adjustedArgs.push(args[i]);
      i++;
      adjustedArgs.push(args.slice(i).join(" "));
      i = args.length;
    }
  } else {
    adjustedArgs.push(args[i]);
  }
}
program.parse(adjustedArgs);
