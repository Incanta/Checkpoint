import { program } from "commander";
import { loginCommand } from "./cli/login";
import { logoutCommand } from "./cli/logout";
import { addCommand } from "./cli/add";
import { rmCommand } from "./cli/rm";
import { statusCommand } from "./cli/status";
import { submitCommand } from "./cli/submit";
import { initCommand } from "./cli/init";
import { whoamiCommand } from "./cli/whoami";
import { pullCommand } from "./cli/pull";

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
initCommand(program);
whoamiCommand(program);
pullCommand(program);

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
    for (let j = i; j < args.length; j++) {
      if (args[i] === "-m" || args[i] === "--message") {
        adjustedArgs.push(args[i]);

        for (let k = i + 1; k < args.length; k++) {
          if (args[k].startsWith("-")) {
            adjustedArgs.push(args.slice(i + 1, k).join(" "));
            i = k;
            break;
          }
          if (k === args.length - 1) {
            adjustedArgs.push(args.slice(i + 1).join(" "));
            i = args.length;
            break;
          }
        }
      } else {
        adjustedArgs.push(args[j]);
      }
    }
    break;
  } else {
    adjustedArgs.push(args[i]);
  }
}
program.parse(adjustedArgs);
