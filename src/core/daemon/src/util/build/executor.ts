import { spawn } from "child_process";
import path from "path";
import { promises as fs } from "fs";
import {
  CreateApiClientAuth,
  type GameSyncConfig,
} from "@checkpointvcs/common";

import {
  getWorkspaceState,
  saveWorkspaceState,
  WORKSPACE_STATE_VERSION,
  type Workspace,
  type WorkspaceState,
} from "../util.js";
import { getProjectInfo } from "../unreal/index.js";
import { writeVersionFiles } from "./version-files.js";
import {
  expandVariables,
  hostPlatformName,
  type BuildVariableContext,
} from "./variables.js";
import { readReceipt } from "./receipts.js";
import {
  getDefaultBuildSteps,
  mergeBuildSteps,
  topoSortSteps,
} from "./steps.js";
import { JobManager, type JobStepState } from "../../job-manager.js";
import { Logger } from "../../logging.js";

export interface BuildOptions {
  /** Force a clean rebuild regardless of ForceClean boundaries. */
  forceClean?: boolean;
  /** True when triggered by a scheduled sync (uses scheduledSync filtering). */
  scheduled?: boolean;
  /** Restrict the run to these step ids (bypasses normal/scheduled filtering). */
  stepIds?: string[];
}

export interface BuildRunResult {
  success: boolean;
  /** Step ids that actually started (in run order). */
  ranSteps: string[];
  /** True when at least one compile step ran. */
  compiled: boolean;
}

/** Wrap a value in double quotes for shell-safe interpolation. */
function quote(value: string): string {
  return `"${value}"`;
}

/** Absolute path to the host UBT Build script for the current OS. */
function buildScriptPath(engineDir: string): string {
  const base = path.join(engineDir, "Engine", "Build", "BatchFiles");
  if (process.platform === "win32") {
    return path.join(base, "Build.bat");
  }
  if (process.platform === "darwin") {
    return path.join(base, "Mac", "Build.sh");
  }
  return path.join(base, "Linux", "Build.sh");
}

/** Absolute path to the host RunUAT script for the current OS. */
function runUatScriptPath(engineDir: string): string {
  const base = path.join(engineDir, "Engine", "Build", "BatchFiles");
  return path.join(base, process.platform === "win32" ? "RunUAT.bat" : "RunUAT.sh");
}

/**
 * Spawn a command through the host shell, line-buffering stdout/stderr to the
 * job log (and an optional per-line sink for the on-disk log file). Registers a
 * cancel handler that kills the whole child process tree. Resolves with the
 * process exit code (-1 when the process failed to launch).
 *
 * The command is run through a shell because UBT ships `.bat` entry points on
 * Windows, which `spawn` cannot execute directly with `shell:false`.
 */
export async function spawnStreaming(
  jobId: string,
  cmd: string,
  args: string[],
  cwd: string,
  onLine?: (stream: "out" | "err", line: string) => void,
): Promise<number> {
  const jobManager = JobManager.Get();
  const fullCommand = [cmd, ...args].filter((token) => token.length > 0).join(" ");

  return new Promise<number>((resolve) => {
    const child =
      process.platform === "win32"
        ? spawn("cmd.exe", ["/d", "/s", "/c", fullCommand], {
            cwd,
            windowsVerbatimArguments: true,
          })
        : spawn("/bin/sh", ["-c", fullCommand], {
            cwd,
            // detached so we can signal the whole process group on cancel.
            detached: true,
          });

    const buffers: Record<"out" | "err", { text: string }> = {
      out: { text: "" },
      err: { text: "" },
    };

    const consume = (stream: "out" | "err", chunk: Buffer): void => {
      const buffer = buffers[stream];
      buffer.text += chunk.toString();
      let newlineIndex: number;
      while ((newlineIndex = buffer.text.indexOf("\n")) >= 0) {
        const line = buffer.text.slice(0, newlineIndex).replace(/\r$/, "");
        buffer.text = buffer.text.slice(newlineIndex + 1);
        jobManager.appendLog(jobId, stream, line);
        onLine?.(stream, line);
      }
    };

    const flush = (): void => {
      for (const stream of ["out", "err"] as const) {
        const buffer = buffers[stream];
        if (buffer.text.length > 0) {
          const line = buffer.text.replace(/\r$/, "");
          jobManager.appendLog(jobId, stream, line);
          onLine?.(stream, line);
          buffer.text = "";
        }
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => consume("out", chunk));
    child.stderr?.on("data", (chunk: Buffer) => consume("err", chunk));

    // Kill the entire child process tree when the job is cancelled.
    jobManager.onCancel(jobId, () => {
      const pid = child.pid;
      if (pid == null) return;
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"]);
      } else {
        try {
          // Negative pid signals the process group (child is a group leader).
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already exited.
          }
        }
      }
    });

    child.on("error", (err) => {
      const line = `Failed to launch command: ${err.message}`;
      jobManager.appendLog(jobId, "err", line);
      onLine?.("err", line);
      flush();
      resolve(-1);
    });

    child.on("close", (code) => {
      flush();
      resolve(code ?? -1);
    });
  });
}

/**
 * Run the workspace's build steps after a sync (UnrealGameSync parity).
 *
 * Loads workspace state, the resolved repo Game Sync config (at the synced
 * changelist), and the Unreal project/engine info; merges and orders the build
 * steps; then runs them in sequence, streaming logs to the job and a per-build
 * log file. On success, records the last-built changelist, optionally rewrites
 * version files, and casts a best-effort auto compile vote.
 *
 * Throws when no Unreal engine/project can be resolved (nothing to build).
 */
export async function runBuild(
  workspace: Workspace,
  orgId: string,
  jobId: string,
  options: BuildOptions,
  onStepStates?: (states: JobStepState[]) => void,
): Promise<BuildRunResult> {
  // orgId is accepted for parity with other pipeline entry points; the build
  // engine resolves everything it needs from the workspace + app client.
  void orgId;

  const jobManager = JobManager.Get();
  const state = await getWorkspaceState(workspace.localPath);
  const changelistNumber = state.changelistNumber;

  const projectInfo = await getProjectInfo(workspace, state);
  if (!projectInfo || !projectInfo.engine || !projectInfo.uprojectPath) {
    const message =
      "Cannot build: no Unreal engine or project could be resolved for this workspace.";
    jobManager.appendLog(jobId, "sys", message);
    throw new Error(message);
  }

  const engine = projectInfo.engine;
  const engineDir = engine.engineDir;

  // Resolve the repo Game Sync config at the synced changelist (best effort).
  let config: GameSyncConfig | null = null;
  try {
    const client = await CreateApiClientAuth(workspace.daemonId);
    const result = await client.gameSync.getConfig.query({
      repoId: workspace.repoId,
      changelistNumber,
    });
    config = result.config;
  } catch (e) {
    Logger.warn(
      `Build: failed to fetch Game Sync config: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const editorTarget =
    projectInfo.editorTargetName ?? config?.project?.editorTarget ?? "UnrealEditor";
  const platformName = hostPlatformName();
  const projectFile = path.join(workspace.localPath, projectInfo.uprojectPath);
  const projectDir = path.dirname(projectFile);
  const branchDir = workspace.localPath;

  // Merge default + repo-config + custom steps, apply overrides, filter, order.
  const merged = mergeBuildSteps(
    getDefaultBuildSteps(editorTarget),
    config?.buildSteps ?? [],
    workspace.gameSync?.customBuildSteps ?? [],
    workspace.gameSync?.buildStepOverrides,
  );

  const selected = merged
    .filter(({ enabled }) => enabled)
    .filter(({ step }) => {
      if (options.stepIds && options.stepIds.length > 0) {
        return options.stepIds.includes(step.id);
      }
      return options.scheduled ? step.scheduledSync : step.normalSync;
    })
    .map(({ step }) => step);

  const ordered = topoSortSteps(selected);

  // Editor executable: prefer the receipt's Launch path, else the convention.
  let editorExe: string;
  const editorReceipt = await readReceipt(
    engineDir,
    projectDir,
    editorTarget,
    platformName,
    "Development",
  );
  if (editorReceipt?.launch) {
    editorExe = editorReceipt.launch;
  } else {
    const exeName =
      platformName === "Win64" ? "UnrealEditor.exe" : "UnrealEditor";
    editorExe = path.join(engineDir, "Engine", "Binaries", platformName, exeName);
  }

  const ctx: BuildVariableContext = {
    branchDir,
    projectDir,
    projectFile,
    engineDir,
    editorExe,
    change: changelistNumber,
    clientName: workspace.workspaceName,
    platformName,
    editorTarget,
  };

  // ForceClean: explicit option, or a config boundary crossed since last build.
  const lastBuilt = state.gameSync?.lastBuiltChangelist ?? -1;
  const cleanByBoundary = (config?.forceClean?.changelists ?? []).some(
    (boundary) => lastBuilt < boundary && boundary <= changelistNumber,
  );
  const clean = Boolean(options.forceClean) || cleanByBoundary;

  // Set up the on-disk log file.
  const logsDir = path.join(workspace.localPath, ".checkpoint", "logs");
  await fs.mkdir(logsDir, { recursive: true });
  const logFilePath = path.join(logsDir, `build-${jobId}.log`);
  jobManager.setLogFilePath(jobId, logFilePath);
  const logHandle = await fs.open(logFilePath, "a");

  // Serialize log-file writes so lines are not interleaved out of order.
  let logChain: Promise<unknown> = Promise.resolve();
  const writeLogLine = (
    stream: "out" | "err" | "sys",
    line: string,
  ): void => {
    logChain = logChain
      .then(() => logHandle.write(`[${stream}] ${line}\n`))
      .catch(() => {
        // Log-file write failure must never abort a build.
      });
  };
  const sysLog = (line: string): void => {
    jobManager.appendLog(jobId, "sys", line);
    writeLogLine("sys", line);
  };

  const notifySteps = (): void => {
    onStepStates?.(jobManager.getJob(jobId)?.stepStates ?? []);
  };

  const stepStates: JobStepState[] = ordered.map((step) => ({
    id: step.id,
    description: step.name,
    status: "pending",
  }));
  jobManager.setStepStates(jobId, stepStates);
  notifySteps();

  let success = true;
  let cancelled = false;
  let compiled = false;
  const ranSteps: string[] = [];

  try {
    if (ordered.length === 0) {
      sysLog("No enabled build steps to run.");
    }
    if (clean) {
      sysLog("Force clean is active: compile steps will run with -Clean.");
    }

    for (let i = 0; i < ordered.length; i++) {
      const step = ordered[i]!;

      // Cancellation requested between steps.
      if (jobManager.getJob(jobId)?.cancelRequested) {
        cancelled = true;
        success = false;
        for (let j = i; j < ordered.length; j++) {
          jobManager.updateStepState(jobId, ordered[j]!.id, {
            status: "cancelled",
          });
        }
        notifySteps();
        break;
      }

      jobManager.updateStepState(jobId, step.id, { status: "running" });
      notifySteps();
      const startedAt = Date.now();

      let cmd: string;
      let args: string[];
      let cwd: string;

      if (step.type === "compile") {
        const target = step.target ?? editorTarget;
        const platform = step.platform ?? platformName;
        const configuration = step.configuration ?? "Development";
        cmd = quote(buildScriptPath(engineDir));
        args = [
          target,
          platform,
          configuration,
          `-Project=${quote(projectFile)}`,
          "-WaitMutex",
          "-NoHotReloadFromIDE",
        ];
        if (step.arguments) {
          args.push(expandVariables(step.arguments, ctx));
        }
        if (clean) {
          args.push("-Clean");
        }
        cwd = engineDir;
        compiled = true;
      } else if (step.type === "cook") {
        cmd = quote(runUatScriptPath(engineDir));
        args = step.arguments ? [expandVariables(step.arguments, ctx)] : [];
        cwd = step.workingDir
          ? expandVariables(step.workingDir, ctx)
          : engineDir;
      } else {
        // "other": free-form command.
        cmd = step.command ? expandVariables(step.command, ctx) : "";
        args = step.arguments ? [expandVariables(step.arguments, ctx)] : [];
        cwd = step.workingDir
          ? expandVariables(step.workingDir, ctx)
          : branchDir;
      }

      sysLog(`Running step "${step.name}": ${[cmd, ...args].join(" ")}`);
      ranSteps.push(step.id);

      const exitCode = await spawnStreaming(jobId, cmd, args, cwd, writeLogLine);
      const durationMs = Date.now() - startedAt;

      // A cancel during the step surfaces as a killed process; record it as
      // cancelled (not failed) so it does not count as a compile failure.
      if (jobManager.getJob(jobId)?.cancelRequested) {
        cancelled = true;
        success = false;
        jobManager.updateStepState(jobId, step.id, {
          status: "cancelled",
          durationMs,
        });
        for (let j = i + 1; j < ordered.length; j++) {
          jobManager.updateStepState(jobId, ordered[j]!.id, {
            status: "cancelled",
          });
        }
        notifySteps();
        break;
      }

      if (exitCode === 0) {
        jobManager.updateStepState(jobId, step.id, {
          status: "succeeded",
          exitCode: 0,
          durationMs,
        });
        notifySteps();
      } else {
        jobManager.updateStepState(jobId, step.id, {
          status: "failed",
          exitCode,
          durationMs,
        });
        for (let j = i + 1; j < ordered.length; j++) {
          jobManager.updateStepState(jobId, ordered[j]!.id, {
            status: "skipped",
          });
        }
        notifySteps();
        success = false;
        sysLog(`Step "${step.name}" failed with exit code ${exitCode}.`);
        break;
      }
    }

    // Record the last-built changelist on overall success.
    if (success) {
      try {
        const latest = await getWorkspaceState(workspace.localPath);
        const nextState: WorkspaceState = {
          ...latest,
          version: WORKSPACE_STATE_VERSION,
          gameSync: {
            ...latest.gameSync,
            lastBuiltChangelist: changelistNumber,
          },
        };
        await saveWorkspaceState(workspace, nextState);
      } catch (e) {
        Logger.warn(
          `Build: failed to persist lastBuiltChangelist: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      // Only rewrite version files for a locally compiled build.
      if (compiled && workspace.gameSync?.writeVersionFiles) {
        try {
          await writeVersionFiles(
            workspace,
            changelistNumber,
            workspace.branchName,
          );
        } catch (e) {
          Logger.warn(
            `Build: failed to write version files: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }

    // Best-effort auto compile vote (skip on cancellation).
    if (compiled && !cancelled) {
      try {
        const client = await CreateApiClientAuth(workspace.daemonId);
        await client.changelistReview.setVote.mutate({
          repoId: workspace.repoId,
          changelistNumber,
          vote: success ? "COMPILE_SUCCESS" : "COMPILE_FAILURE",
        });
      } catch (e) {
        Logger.warn(
          `Build: failed to cast auto compile vote: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  } finally {
    await logChain;
    await logHandle.close();
  }

  return { success, ranSteps, compiled };
}
