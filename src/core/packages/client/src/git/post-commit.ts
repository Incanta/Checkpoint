import { CheckpointConfig } from "../config";
import { GetLogger } from "../logging";
import { exec } from "../util";

export enum PostCommitHookResult {
  Success = 0,
  FetchFailed = 10,
  MergeFailed = 11,
  PushFailed = 12,
}

export async function PostCommitHook(
  config: CheckpointConfig
): Promise<PostCommitHookResult> {
  const logger = GetLogger(config);

  const { stdout: lastCommitHash } = await exec("git rev-parse HEAD");
  logger.info(`Last commit hash: ${lastCommitHash}`);

  const { code: fetchCode } = await exec("git fetch");

  if (fetchCode !== 0) {
    logger.fatal("Failed to fetch from remote, undoing last commit...");
    await exec(`git reset --soft ${lastCommitHash}~1`);
    return PostCommitHookResult.FetchFailed;
  }

  const { code: mergeCode } = await exec("git merge");

  if (mergeCode !== 0) {
    logger.fatal("Failed to merge, undoing last commit...");
    await exec("git merge --abort");
    await exec(`git reset --soft ${lastCommitHash}~1`);
    return PostCommitHookResult.MergeFailed;
  }

  const { code: pushCode } = await exec("git push");

  if (pushCode !== 0) {
    logger.fatal("Failed to push, undoing last commit...");
    await exec(`git reset --soft ${lastCommitHash}~1`);
    return PostCommitHookResult.PushFailed;
  }

  return PostCommitHookResult.Success;
}
