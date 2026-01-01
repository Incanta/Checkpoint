import config from "@incanta/config";
import { ptr, toArrayBuffer } from "bun:ffi";
import {
  CreateLongtailLibrary,
  createStringBuffer,
  decodeHandle,
  DiffState,
  GetLogLevel,
  type LongtailLogLevel,
  CreateApiClientAuth,
} from "@checkpointvcs/common";
import { getWorkspaceState, saveWorkspaceState, type Workspace } from "./util";
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

  const workspaceState = await getWorkspaceState();

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

  // on windows, requires PATH to include libraries folder
  const lib = CreateLongtailLibrary();

  let errored = false;
  let lastStep = "";
  for (const versionIndex of versionsToPull) {
    if (versionIndex === "") {
      continue;
    }

    const versionIndexBuffer = createStringBuffer(versionIndex);
    const localPathBuffer = createStringBuffer(workspace.localPath);
    const remoteRootBuffer = createStringBuffer(
      `/${orgId}/${workspace.repoId}`,
    );
    const filerUrlBuffer = createStringBuffer(filerUrl);
    const tokenBuffer = createStringBuffer(token);

    const asyncHandle = lib.PullAsync(
      ptr(versionIndexBuffer.buffer),
      config.get<boolean>("longtail.enable-mmap-indexing") ? 1 : 0,
      config.get<boolean>("longtail.enable-mmap-block-store") ? 1 : 0,
      ptr(localPathBuffer.buffer),
      ptr(remoteRootBuffer.buffer),
      ptr(filerUrlBuffer.buffer),
      ptr(tokenBuffer.buffer),
      tokenExpirationMs,
      GetLogLevel(logLevel),
    );

    if (asyncHandle === 0 || asyncHandle === null) {
      throw new Error("Failed to create longtail handle");
    }

    let flagForGC = true;

    while (true) {
      const decoded = decodeHandle(
        new Uint8Array(toArrayBuffer(asyncHandle, 0, 272)),
      );

      if (decoded.currentStep !== lastStep) {
        lastStep = decoded.currentStep;
      }

      if (decoded.completed) {
        if (decoded.error !== 0) {
          console.log(
            `Completed with exit code: ${decoded.error} and last step ${decoded.currentStep}`,
          );
        }
        flagForGC = false;
        break;
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }

    const decoded = decodeHandle(
      new Uint8Array(toArrayBuffer(asyncHandle, 0, 2320)),
      true,
    );

    if (flagForGC) {
      console.log(versionIndexBuffer);
      console.log(localPathBuffer);
      console.log(remoteRootBuffer);
      console.log(filerUrlBuffer);
      console.log(tokenBuffer);
    }

    lib.FreeHandle(asyncHandle);

    if (decoded.error !== 0) {
      errored = true;
      break;
    }
  }

  if (!errored) {
    const filesResponse: any = await client.file.getFiles.query({
      ids: diff.deletions,
    });

    for (const file of filesResponse.files) {
      if (file.path) {
        const filePath = path.join(workspace.localPath, file.path);

        if (existsSync(filePath)) {
          await fs.rm(filePath, {
            force: true,
          });
        }
      }
    }

    await saveWorkspaceState({
      changelistNumber: changelistResponse.number,
      files: changelistResponse.stateTree as Record<string, number>,
    });
  }

  if (errored) {
    throw new Error("Pull failed: " + lastStep);
  }
}
