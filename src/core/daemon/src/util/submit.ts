import {
  type Modification,
  CreateApiClientAuth,
  GetAuthConfigUser,
  hashFile,
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

  let filerUrl = "";
  let token = "";
  let backendUrl = "";
  if (storageTokenResponse.storageType === "r2") {
    // R2: no filer URL needed
  } else {
    token = storageTokenResponse.token;
    backendUrl = storageTokenResponse.backendUrl;
    filerUrl = await fetch(`${backendUrl}/filer-url`).then((res) => res.text());
  }

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
      `[submit]   Using R2 storage with endpoint: ${storageTokenResponse.r2Credentials?.endpoint}`,
    );
  } else {
    console.log(`[submit]   filerUrl: ${filerUrl}`);
    console.log(`[submit]   jwt token: ${token}`);
    console.log(`[submit]   backendUrl: ${backendUrl}`);
  }
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

  const { status, result } = await pollHandle(handle, {
    onStep: (step) => {
      console.log(`[submit] Step: ${step}`);
      onStep?.(step);
    },
    onProgress: (step, done, total) => {
      onProgress?.(step, done, total);
    },
  });

  if (status.error !== 0) {
    console.log(
      `Completed with exit code: ${status.error} and last step ${status.currentStep}`,
    );
  }

  freeHandle(handle);

  if (status.error === 0 && result) {
    onStep?.("Updating workspace state");
    const workspaceState = await getWorkspaceState(workspace.localPath);

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
        // Add/update the file entry with full info
        const fullPath = path.join(workspace.localPath, modification.path);
        const stat = await fs.stat(fullPath);
        const hash = await hashFile(fullPath);

        const stateFile: WorkspaceStateFile = {
          fileId: fileId,
          changelist: result.changelistNumber,
          hash: hash,
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

    await saveWorkspaceState(workspace, workspaceState);
  }

  if (status.error !== 0) {
    throw new Error(
      `Error submitting changes: ${status.error} ${status.currentStep}`,
    );
  }

  console.log(`[submit] Submit completed successfully.`);
}
