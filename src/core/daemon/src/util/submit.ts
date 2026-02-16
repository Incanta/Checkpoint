import config from "@incanta/config";
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
} from "@checkpointvcs/longtail-addon";
import {
  getWorkspaceState,
  saveWorkspaceState,
  type Workspace,
} from "./util.js";
import path from "path";
import { promises as fs } from "fs";

export async function submit(
  workspace: Workspace,
  orgId: string,
  message: string,
  modifications: Modification[],
  workspaceId: string,
  keepCheckedOut: boolean = false,
  logLevel: LongtailLogLevel = config.get<LongtailLogLevel>(
    "longtail.log-level",
  ),
): Promise<void> {
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

  if (
    !storageTokenResponse ||
    !storageTokenResponse.token ||
    !storageTokenResponse.expiration ||
    !storageTokenResponse.backendUrl
  ) {
    throw new Error("Could not get storage token");
  }

  const token = storageTokenResponse.token;
  const tokenExpirationMs = storageTokenResponse.expiration * 1000;
  const backendUrl = storageTokenResponse.backendUrl;

  const filerUrl = await fetch(`${backendUrl}/filer-url`).then((res) =>
    res.text(),
  );

  console.log(`[submit] Calling SubmitAsync:`);
  console.log(`[submit]   branchName: ${workspace.branchName}`);
  console.log(`[submit]   message: ${message}`);
  console.log(`[submit]   localPath: ${workspace.localPath}`);
  console.log(`[submit]   remoteRoot: /${orgId}/${workspace.repoId}`);
  console.log(`[submit]   filerUrl: ${filerUrl}`);
  console.log(`[submit]   jwt token: ${token}`);
  console.log(`[submit]   backendUrl: ${backendUrl}`);
  console.log(`[submit]   workspaceId: ${workspaceId}`);
  console.log(`[submit]   modifications: ${modifications.length}`);

  const handle = submitAsync({
    branchName: workspace.branchName,
    message,
    targetChunkSize: config.get<number>("longtail.target-chunk-size"),
    targetBlockSize: config.get<number>("longtail.target-block-size"),
    maxChunksPerBlock: config.get<number>("longtail.max-chunks-per-block"),
    minBlockUsagePercent: config.get<number>(
      "longtail.min-block-usage-percent",
    ),
    hashingAlgo: config.get<string>("longtail.hashing-algo"),
    compressionAlgo: config.get<string>("longtail.compression-algo"),
    enableMmapIndexing: config.get<boolean>("longtail.enable-mmap-indexing"),
    enableMmapBlockStore: config.get<boolean>(
      "longtail.enable-mmap-block-store",
    ),
    localRootPath: workspace.localPath,
    remoteBasePath: `/${orgId}/${workspace.repoId}`,
    filerUrl,
    backendUrl,
    jwt: token,
    jwtExpirationMs: tokenExpirationMs,
    apiJwt: user.apiToken,
    keepCheckedOut,
    workspaceId,
    modifications,
    logLevel: GetLogLevel(logLevel),
  });

  if (!handle) {
    throw new Error("Failed to create longtail handle");
  }

  const { status, result } = await pollHandle(handle, {
    onStep: (step) => {
      console.log(`[submit] Step: ${step}`);
    },
  });

  if (status.error !== 0) {
    console.log(
      `Completed with exit code: ${status.error} and last step ${status.currentStep}`,
    );
  }

  freeHandle(handle);

  if (status.error === 0 && result) {
    const workspaceState = await getWorkspaceState(workspace.localPath);

    workspaceState.changelistNumber = result.changelistNumber;

    const fileIds = await client.file.getFileIds.query({
      repoId: workspace.repoId,
      paths: modifications.map((mod) => mod.path),
    });

    for (const modification of modifications) {
      // Normalize the path (use forward slashes, no leading slash)
      const normalizedPath = modification.path
        .replace(/\\/g, "/")
        .replace(/^\//, "");
      const fileId = fileIds.find(
        (f) => f.path === normalizedPath || f.path === modification.path,
      )?.id;

      if (!fileId) {
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
