import {
  type Modification,
  CreateApiClientAuth,
  GetAuthConfigUser,
  type WorkspaceStateFile,
} from "@checkpointvcs/common";
import {
  submitAsync,
  pollHandle,
  freeHandle,
  GetLogLevel,
  type LongtailLogLevel,
  type SubmitAsyncOptions,
} from "@checkpointvcs/longtail-addon";
import {
  getWorkspaceState,
  saveWorkspaceState,
  type Workspace,
} from "./util.js";
import path from "path";
import { promises as fs } from "fs";
import { DaemonConfig } from "../daemon-config.js";

export async function submit(
  workspace: Workspace,
  orgId: string,
  message: string,
  modifications: Modification[],
  workspaceId: string,
  keepCheckedOut: boolean = false,
  logLevel?: LongtailLogLevel,
  onStep?: (step: string) => void,
  onProgress?: (step: string, done: number, total: number) => void,
  shelfName?: string,
  artifactForChangelistNum?: number,
): Promise<void> {
  const daemonConfig = await DaemonConfig.Get();
  const resolvedLogLevel =
    logLevel ?? (daemonConfig.longtail.logLevel as LongtailLogLevel);
  const stateBackend = daemonConfig.stateBackend;
  const user = await GetAuthConfigUser(workspace.daemonId);

  if (!user) {
    throw new Error("Could not get user");
  }

  if (!user.apiToken) {
    throw new Error("User not authenticated");
  }

  const client = await CreateApiClientAuth(workspace.daemonId);

  const storageTokenResponse = await client.storage.getToken.query({
    repoId: workspace.repoId,
    write: true,
  });

  if (!storageTokenResponse || !storageTokenResponse.expiration) {
    throw new Error("Could not get storage token");
  }

  const tokenExpirationMs = storageTokenResponse.expiration * 1000;

  const token = storageTokenResponse.token;
  const backendUrl = storageTokenResponse.backendUrl;
  const filerUrl =
    storageTokenResponse.storageType === "r2"
      ? ""
      : await fetch(`${backendUrl}/filer-url`).then((res) => res.text());

  console.log(`[submit] Calling SubmitAsync:`);
  console.log(`[submit]   branchName: ${workspace.branchName}`);
  if (shelfName) {
    console.log(`[submit]   shelfName: ${shelfName}`);
  }
  console.log(`[submit]   message: ${message}`);
  console.log(`[submit]   localPath: ${workspace.localPath}`);
  console.log(`[submit]   remoteRoot: /${orgId}/${workspace.repoId}`);
  if (storageTokenResponse.storageType === "r2") {
    console.log(
      `[submit]   Using R2 storage with endpoint: ${storageTokenResponse.r2Credentials?.endpoint}`
    );
    console.log(
      `[submit]   R2 bucket name: ${storageTokenResponse.r2Credentials?.bucket}`,
    );
  } else {
    console.log(`[submit]   filerUrl: ${filerUrl}`);
  }
  console.log(`[submit]   backendUrl: ${backendUrl}`);
  console.log(`[submit]   workspaceId: ${workspaceId}`);
  console.log(`[submit]   modifications: ${modifications.length}`);

  const submitOptions: SubmitAsyncOptions = {
    branchName: workspace.branchName,
    message,
    targetChunkSize: daemonConfig.longtail.targetChunkSize,
    targetBlockSize: daemonConfig.longtail.targetBlockSize,
    maxChunksPerBlock: daemonConfig.longtail.maxChunksPerBlock,
    minBlockUsagePercent: daemonConfig.longtail.minBlockUsagePercent,
    hashingAlgo: daemonConfig.longtail.hashingAlgo,
    compressionAlgo: daemonConfig.longtail.compressionAlgo,
    enableMmapIndexing: daemonConfig.longtail.enableMmapIndexing,
    enableMmapBlockStore: daemonConfig.longtail.enableMmapBlockStore,
    localRootPath: workspace.localPath,
    remoteBasePath: `/${orgId}/${workspace.repoId}`,
    filerUrl,
    backendUrl,
    jwt: token,
    jwtExpirationMs: tokenExpirationMs,
    storageType: storageTokenResponse.storageType,
    ...(storageTokenResponse.r2Credentials && {
      r2AccessKeyId: storageTokenResponse.r2Credentials.accessKeyId,
      r2SecretAccessKey: storageTokenResponse.r2Credentials.secretAccessKey,
      r2SessionToken: storageTokenResponse.r2Credentials.sessionToken,
      r2Endpoint: storageTokenResponse.r2Credentials.endpoint,
      r2BucketName: storageTokenResponse.r2Credentials.bucket,
    }),
    apiJwt: user.apiToken,
    keepCheckedOut,
    workspaceId,
    modifications,
    logLevel: GetLogLevel(resolvedLogLevel),
  };

  if (shelfName) {
    submitOptions.shelfName = shelfName;
  }

  if (artifactForChangelistNum != null && artifactForChangelistNum >= 0) {
    submitOptions.artifactForChangelistNum = artifactForChangelistNum;
  }

  const handle = submitAsync(submitOptions);
  if (!handle) {
    throw new Error("Failed to create longtail handle");
  }

  // Per-stage wall-clock breakdown of the native submit (indexing, getting
  // existing content, writing blocks, flushing, uploading). We always observe
  // step transitions via onStep (it is cheap, one timestamp per transition) so
  // the breakdown is captured even with --no-progress; pollHandle invokes
  // onStep on every step change regardless of progress reporting. Granularity is
  // the poll interval, which we keep coarse (250ms) when no consumer asked for
  // progress, so this adds no meaningful overhead.
  const stagesMs: Record<string, number> = {};
  let lastStage = "";
  let stageStart = Date.now();
  const recordStageTransition = (next: string) => {
    const now = Date.now();
    if (lastStage) {
      stagesMs[lastStage] = (stagesMs[lastStage] ?? 0) + (now - stageStart);
    }
    stageStart = now;
    lastStage = next;
  };

  // Whether a consumer (e.g. the CLI without --no-progress) wants progress
  // callbacks. We still wire onStep internally for timing either way.
  const wantProgress = !!(onStep || onProgress);

  const pollOptions: Parameters<typeof pollHandle>[1] = {
    onTokenRefresh: async () => {
      console.log("[submit] Token refresh requested by native addon");
      const newToken = await client.storage.getToken.query({
        repoId: workspace.repoId,
        write: true,
      });
      console.log("[submit] Token refreshed successfully");
      return {
        jwt: newToken.token,
        jwtExpirationMs: (newToken.expiration ?? 0) * 1000,
        ...(newToken.r2Credentials && {
          r2AccessKeyId: newToken.r2Credentials.accessKeyId,
          r2SecretAccessKey: newToken.r2Credentials.secretAccessKey,
          r2SessionToken: newToken.r2Credentials.sessionToken,
        }),
      };
    },
    onStep: (step) => {
      recordStageTransition(step);
      if (onStep) {
        console.log(`[submit] Step: ${step}`);
        onStep(step);
      }
    },
  };
  if (onProgress) {
    pollOptions.onProgress = (step, done, total) => onProgress(step, done, total);
  }
  if (!wantProgress) {
    pollOptions.intervalMs = 250;
  }

  const { status, result } = await pollHandle(handle, pollOptions);

  // Close out the final stage and emit the breakdown as one parseable line so
  // tooling (e.g. the benchmark harness) can attribute where a large submit
  // spends its time. Values are milliseconds.
  if (lastStage) {
    stagesMs[lastStage] = (stagesMs[lastStage] ?? 0) + (Date.now() - stageStart);
  }
  console.log(
    `[submit-timing] ${JSON.stringify({
      modifications: modifications.length,
      stagesMs,
    })}`,
  );

  if (status.error !== 0) {
    console.log(
      `Completed with exit code: ${status.error} and last step ${status.currentStep}`,
    );
  }

  freeHandle(handle);

  if (status.error === 0 && result) {
    onStep?.("Updating workspace state");
    const workspaceState = await getWorkspaceState(
      workspace.localPath,
      stateBackend,
    );

    workspaceState.changelistNumber = result.changelistNumber;

    const fileIds = await client.file.getFileIds.mutate({
      repoId: workspace.repoId,
      paths: modifications.map((mod) => mod.path),
    });

    let processed = 0;
    const total = modifications.length;
    onProgress?.("Updating workspace state", 0, total);

    for (const modification of modifications) {
      // Normalize the path (use forward slashes, no leading slash)
      const normalizedPath = modification.path
        .replace(/\\/g, "/")
        .replace(/^\//, "");
      const fileId = fileIds.find(
        (f) => f.path === normalizedPath || f.path === modification.path,
      )?.id;

      if (!fileId) {
        processed++;
        onProgress?.("Updating workspace state", processed, total);
        continue;
      }

      if (modification.delete) {
        // Remove the file entry using the path key
        delete workspaceState.files[normalizedPath];
      } else {
        // Add/update the file entry — hash deferred until change detection
        const fullPath = path.join(workspace.localPath, modification.path);
        const stat = await fs.stat(fullPath);

        const stateFile: WorkspaceStateFile = {
          fileId: fileId,
          changelist: result.changelistNumber,
          md5: "",
          size: stat.size,
          mtime: stat.mtimeMs,
        };

        workspaceState.files[normalizedPath] = stateFile;
      }

      processed++;
      onProgress?.("Updating workspace state", processed, total);
    }

    // we do not update the workspace state changelist number here
    // because they may need to sync other changes. we don't
    // auto pull during a push.

    await saveWorkspaceState(workspace, workspaceState, stateBackend);
  }

  if (status.error !== 0) {
    throw new Error(
      `Error submitting changes: ${status.error} ${status.currentStep}`,
    );
  }

  console.log(`[submit] Submit completed successfully.`);
}
