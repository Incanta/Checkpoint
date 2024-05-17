import path from "path";
import { promises as fs } from "fs";
import { exec } from "./util";

export async function UpdateGitHooks(directory: string): Promise<void> {
  // find the .git directory in any parent directory
  const dirParts = directory.split(path.sep);
  while (dirParts.length > 0) {
    try {
      await fs.stat(path.join(...dirParts, ".git"));
      break;
    } catch (e) {
      dirParts.pop();
    }
  }

  if (dirParts.length === 0) {
    throw new Error("Could not find .git directory");
  }

  const gitDir = path.join(...dirParts, ".git");

  console.log(`Found .git directory at ${gitDir}`);

  fs.mkdir(path.join(gitDir, "hooks"), { recursive: true });
  await PostCommitHook();
}

export async function PostCommitHook(): Promise<void> {
  const { stdout: lastCommitHash } = await exec("git rev-parse HEAD");
  console.log(`Last commit hash: ${lastCommitHash}`);

  const { code: fetchCode } = await exec("git fetch");

  if (fetchCode !== 0) {
    console.log("Failed to fetch from remote, undoing last commit...");
    await exec(`git reset --soft ${lastCommitHash}~1`);
    process.exit(fetchCode);
  }

  const { code: mergeCode } = await exec("git merge");

  if (mergeCode !== 0) {
    console.log("Failed to merge, undoing last commit...");
    await exec("git merge --abort");
    await exec(`git reset --soft ${lastCommitHash}~1`);
    process.exit(mergeCode);
  }

  const { code: pushCode } = await exec("git push");

  if (pushCode !== 0) {
    console.log("Failed to push, undoing last commit...");
    await exec(`git reset --soft ${lastCommitHash}~1`);
    process.exit(pushCode);
  }
}
