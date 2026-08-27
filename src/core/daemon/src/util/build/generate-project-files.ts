import path from "path";
import { promises as fs } from "fs";

import { getWorkspaceState, type Workspace } from "../util.js";
import { getProjectInfo } from "../unreal/index.js";
import { spawnStreaming } from "./executor.js";
import { JobManager } from "../../job-manager.js";

/** Wrap a value in double quotes for shell-safe interpolation. */
function quote(value: string): string {
  return `"${value}"`;
}

/**
 * Generate IDE project files for the workspace (UGS "Generate Project Files").
 *
 * For an in-workspace engine this runs the engine's GenerateProjectFiles
 * script directly; for an installed/registered engine it invokes UBT's
 * `-projectfiles` mode against the project. Streams output to the job and a
 * per-run log file. Throws when no engine can be resolved or the script fails.
 */
export async function runGenerateProjectFiles(
  workspace: Workspace,
  orgId: string,
  jobId: string,
): Promise<void> {
  // orgId is accepted for parity with other pipeline entry points.
  void orgId;

  const jobManager = JobManager.Get();
  const state = await getWorkspaceState(workspace.localPath);

  // Inherently Unreal-only. The clients hide this action for a repo without an
  // `unreal` block in its Team Sync config, so reaching here without an engine
  // means the repo opted in but the engine could not be found.
  const projectInfo = await getProjectInfo(workspace, state);
  if (!projectInfo || !projectInfo.engine) {
    const message =
      "Cannot generate project files: no Unreal engine could be resolved for this workspace. " +
      'This action requires an "unreal" block in the repo\'s Team Sync config and a resolvable engine.';
    jobManager.appendLog(jobId, "sys", message);
    throw new Error(message);
  }

  const engine = projectInfo.engine;
  const engineDir = engine.engineDir;
  const batchFiles = path.join(engineDir, "Engine", "Build", "BatchFiles");
  const projectFile = projectInfo.uprojectPath
    ? path.join(workspace.localPath, projectInfo.uprojectPath)
    : null;

  const logsDir = path.join(workspace.localPath, ".checkpoint", "logs");
  await fs.mkdir(logsDir, { recursive: true });
  const logFilePath = path.join(logsDir, `genprojfiles-${jobId}.log`);
  jobManager.setLogFilePath(jobId, logFilePath);
  const logHandle = await fs.open(logFilePath, "a");

  let logChain: Promise<unknown> = Promise.resolve();
  const writeLogLine = (stream: "out" | "err" | "sys", line: string): void => {
    logChain = logChain
      .then(() => logHandle.write(`[${stream}] ${line}\n`))
      .catch(() => {
        // Log-file write failure must never abort the run.
      });
  };
  const sysLog = (line: string): void => {
    jobManager.appendLog(jobId, "sys", line);
    writeLogLine("sys", line);
  };

  try {
    let cmd: string;
    let args: string[];

    if (engine.kind === "workspace") {
      // In-workspace engine: run its GenerateProjectFiles script.
      const script =
        process.platform === "win32"
          ? path.join(batchFiles, "GenerateProjectFiles.bat")
          : process.platform === "darwin"
            ? path.join(batchFiles, "Mac", "GenerateProjectFiles.sh")
            : path.join(batchFiles, "Linux", "GenerateProjectFiles.sh");
      cmd = quote(script);
      args = [];
    } else {
      // Installed/registered engine: use UBT's -projectfiles mode.
      const script =
        process.platform === "win32"
          ? path.join(batchFiles, "Build.bat")
          : process.platform === "darwin"
            ? path.join(batchFiles, "Mac", "Build.sh")
            : path.join(batchFiles, "Linux", "Build.sh");
      cmd = quote(script);
      args = ["-projectfiles"];
      if (projectFile) {
        args.push(`-project=${quote(projectFile)}`);
      }
      args.push("-game", "-engine");
    }

    sysLog(`Generating project files: ${[cmd, ...args].join(" ")}`);
    const exitCode = await spawnStreaming(jobId, cmd, args, engineDir, writeLogLine);
    if (exitCode !== 0) {
      const message = `Generate project files failed with exit code ${exitCode}.`;
      sysLog(message);
      throw new Error(message);
    }
  } finally {
    await logChain;
    await logHandle.close();
  }
}
