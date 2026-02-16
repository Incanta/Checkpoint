import config from "@incanta/config";
import {
  DiffState,
  CreateApiClientAuth,
  type WorkspaceStateFile,
  hashFile,
} from "@checkpointvcs/common";
import {
  pullAsync,
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
import { existsSync, promises as fs } from "fs";
import path from "path";

export async function pull(
  workspace: Workspace,
  orgId: string,
  changelistNumber: number | null,
  filePaths: string[] | null = null, // TODO: implement partial pulls
  logLevel: LongtailLogLevel = config.get<LongtailLogLevel>(
    "longtail.log-level",
  ),
): Promise<void> {
  const client = await CreateApiClientAuth(workspace.daemonId);

  const storageTokenResponse = await client.storage.getToken.query({
    repoId: workspace.repoId,
    write: true,
  });

  if (
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

  if (changelistNumber === null) {
    const branchResponse = await client.branch.getBranch.query({
      repoId: workspace.repoId,
      name: workspace.branchName,
    });

    if (!branchResponse) {
      throw new Error("Could not get branch information");
    }

    changelistNumber = branchResponse.headNumber;
  }

  const changelistResponse = await client.changelist.getChangelist.query({
    repoId: workspace.repoId,
    changelistNumber: changelistNumber,
  });

  if (!changelistResponse) {
    throw new Error("Could not get changelist information");
  }

  const workspaceState = await getWorkspaceState(workspace.localPath);

  const diff = DiffState(
    workspaceState.files,
    changelistResponse.stateTree as Record<string, number>,
  );

  const changelistsResponse =
    await client.changelist.getChangelistsWithNumbers.query({
      repoId: workspace.repoId,
      numbers: diff.changelistsToPull,
    });

  const sortedChangelists = changelistsResponse.sort(
    (a: any, b: any) => a.number - b.number,
  );

  const versionsToPull: string[] = sortedChangelists.map(
    (changelist: any) => changelist.versionIndex,
  );

  let errored = false;
  let lastStep = "";
  for (const versionIndex of versionsToPull) {
    if (versionIndex === "") {
      continue;
    }

    const handle = pullAsync({
      versionIndex,
      enableMmapIndexing: config.get<boolean>("longtail.enable-mmap-indexing"),
      enableMmapBlockStore: config.get<boolean>(
        "longtail.enable-mmap-block-store",
      ),
      localRootPath: workspace.localPath,
      remoteBasePath: `/${orgId}/${workspace.repoId}`,
      filerUrl,
      jwt: token,
      jwtExpirationMs: tokenExpirationMs,
      logLevel: GetLogLevel(logLevel),
    });

    if (!handle) {
      throw new Error("Failed to create longtail handle");
    }

    const { status } = await pollHandle(handle, {
      onStep: (step) => {
        lastStep = step;
      },
    });

    if (status.error !== 0) {
      console.log(
        `Completed with exit code: ${status.error} and last step ${status.currentStep}`,
      );
    }

    freeHandle(handle);

    if (status.error !== 0) {
      errored = true;
      break;
    }
  }

  if (!errored) {
    // Handle deletions
    const filesResponse = await client.file.getFiles.query({
      ids: diff.deletions,
    });

    for (const file of filesResponse) {
      if (file.path) {
        const filePath = path.join(workspace.localPath, file.path);

        if (existsSync(filePath)) {
          await fs.rm(filePath, {
            force: true,
          });
        }
      }
    }

    // Build new state.json with path keys and file info
    const serverStateTree = changelistResponse.stateTree as Record<
      string,
      number
    >;
    const allFileIds = Object.keys(serverStateTree);

    // Get all file info from server
    const allFilesResponse = await client.file.getFiles.query({
      ids: allFileIds,
    });

    // Build the new state format: Record<path, WorkspaceStateFile>
    const newFiles: Record<string, WorkspaceStateFile> = {};

    for (const file of allFilesResponse) {
      if (!file.path) continue;

      // Normalize path: strip leading slash and use forward slashes
      const normalizedPath = file.path.replace(/^\//, "").replace(/\\/g, "/");
      const filePath = path.join(workspace.localPath, normalizedPath);
      const changelist = serverStateTree[file.id];

      if (existsSync(filePath)) {
        const stat = await fs.stat(filePath);
        const hash = await hashFile(filePath);

        newFiles[normalizedPath] = {
          fileId: file.id,
          changelist: changelist,
          hash: hash,
          size: stat.size,
          mtime: stat.mtimeMs,
        };
      }
    }

    await saveWorkspaceState(workspace, {
      changelistNumber: changelistResponse.number,
      files: newFiles,
    });
  }

  if (errored) {
    throw new Error("Pull failed: " + lastStep);
  }
}
