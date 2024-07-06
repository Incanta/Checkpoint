import path from "path";
import os from "os";
import { exec } from "../util";

export function GetGitGlobalConfigPath(): string {
  return path.join(os.homedir(), ".gitconfig");
}

export async function GetGitConfig(configPath: string): Promise<any> {
  const { stdout } = await exec(`git config --list --file ${configPath}`);

  const configOutput: any = {};

  for (const line of stdout.split("\n")) {
    const [key, value] = line.split("=");
    const keyParts = key.split(".");

    let current = configOutput;
    for (let i = 0; i < keyParts.length; i++) {
      const part = keyParts[i];
      if (i === keyParts.length - 1) {
        current[part] = value;
      } else {
        if (!current[part]) {
          current[part] = {};
        }
        current = current[part];
      }
    }
  }

  return configOutput;
}
