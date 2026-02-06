import config from "@incanta/config";
import { ptr, toArrayBuffer } from "bun:ffi";
import {
  CreateLongtailLibrary,
  createStringBuffer,
  decodeHandle,
  GetLogLevel,
  type LongtailLogLevel,
  type Modification,
  CreateApiClientAuth,
  GetAuthConfigUser,
  hashFile,
} from "@checkpointvcs/common";
import {
  getWorkspaceState,
  saveWorkspaceState,
  type Workspace,
  type WorkspaceStateFile,
} from "./util";
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

  // on windows, requires PATH to include libraries folder
  const lib = CreateLongtailLibrary();

  // struct alignment will pad after the first bool to 8 bytes
  const buffer = new ArrayBuffer((8 + 8 + 8) * modifications.length);
  const view = new DataView(buffer);
  let viewIndex = 0;

  const modificationPathsBuffer: Buffer[] = [];
  const modificationOldPathsBuffer: Buffer[] = [];
  for (let i = 0; i < modifications.length; i++) {
    view.setUint8(viewIndex, modifications[i].delete ? 1 : 0);
    viewIndex += 8;

    modificationPathsBuffer.push(createStringBuffer(modifications[i].path));

    view.setBigUint64(
      viewIndex,
      BigInt(ptr(modificationPathsBuffer[i].buffer)),
      true,
    );
    viewIndex += 8;

    if (modifications[i].oldPath) {
      modificationOldPathsBuffer.push(
        createStringBuffer(modifications[i].oldPath!),
      );
      view.setBigUint64(
        viewIndex,
        BigInt(ptr(modificationOldPathsBuffer[i].buffer)),
        true,
      );
    } else {
      view.setBigUint64(viewIndex, BigInt(0), true);
    }
    viewIndex += 8;
  }

  const filerUrl = await fetch(`${backendUrl}/filer-url`).then((res) =>
    res.text(),
  );

  const branchNameBuffer = createStringBuffer(workspace.branchName);
  const messageBuffer = createStringBuffer(message);
  const hashingAlgoBuffer = createStringBuffer(
    config.get<string>("longtail.hashing-algo"),
  );
  const compressionAlgoBuffer = createStringBuffer(
    config.get<string>("longtail.compression-algo"),
  );
  const localPathBuffer = createStringBuffer(workspace.localPath);
  const remoteRootBuffer = createStringBuffer(`/${orgId}/${workspace.repoId}`);
  const filerUrlBuffer = createStringBuffer(filerUrl);
  const backendUrlBuffer = createStringBuffer(backendUrl);
  const tokenBuffer = createStringBuffer(token);
  const apiTokenBuffer = createStringBuffer(user.apiToken);
  const workspaceIdBuffer = createStringBuffer(workspaceId);

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

  const asyncHandle = lib.SubmitAsync(
    ptr(branchNameBuffer.buffer),
    ptr(messageBuffer.buffer),
    config.get<number>("longtail.target-chunk-size"),
    config.get<number>("longtail.target-block-size"),
    config.get<number>("longtail.max-chunks-per-block"),
    config.get<number>("longtail.min-block-usage-percent"),
    ptr(hashingAlgoBuffer.buffer),
    ptr(compressionAlgoBuffer.buffer),
    config.get<boolean>("longtail.enable-mmap-indexing") ? 1 : 0,
    config.get<boolean>("longtail.enable-mmap-block-store") ? 1 : 0,
    ptr(localPathBuffer.buffer),
    ptr(remoteRootBuffer.buffer),
    ptr(filerUrlBuffer.buffer),
    ptr(backendUrlBuffer.buffer),
    ptr(tokenBuffer.buffer),
    tokenExpirationMs,
    ptr(apiTokenBuffer.buffer),
    keepCheckedOut ? 1 : 0,
    ptr(workspaceIdBuffer.buffer),
    modifications.length,
    ptr(buffer),
    GetLogLevel(logLevel),
  );

  if (asyncHandle === 0 || asyncHandle === null) {
    throw new Error("Failed to create longtail handle");
  }

  let flagForGC = true;
  let lastStep = "";

  while (true) {
    const decoded = decodeHandle(
      new Uint8Array(toArrayBuffer(asyncHandle, 0, 272)),
    );

    if (decoded.currentStep !== lastStep) {
      lastStep = decoded.currentStep;
      console.log(
        `[submit] Step: ${decoded.currentStep.substring(0, decoded.currentStep.indexOf("\0"))}`,
      );
    }

    if (decoded.completed) {
      if (decoded.error !== 0) {
        console.log(
          `Completed with exit code: ${decoded.error} and last step ${decoded.currentStep.substring(0, decoded.currentStep.indexOf("\0"))}`,
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

  if (decoded.error === 0) {
    const workspaceState = await getWorkspaceState(workspace.localPath);

    workspaceState.changelistNumber = decoded.result.changelistNumber;

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
          changelist: decoded.result.changelistNumber,
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

  if (flagForGC) {
    console.log(branchNameBuffer);
    console.log(messageBuffer);
    console.log(hashingAlgoBuffer);
    console.log(compressionAlgoBuffer);
    console.log(localPathBuffer);
    console.log(remoteRootBuffer);
    console.log(filerUrlBuffer);
    console.log(backendUrlBuffer);
    console.log(tokenBuffer);
    console.log(buffer.byteLength);
    console.log(modificationPathsBuffer.length);
    console.log(modificationOldPathsBuffer.length);
  }

  lib.FreeHandle(asyncHandle);

  if (decoded.error !== 0) {
    throw new Error(
      `Error submitting changes: ${decoded.error} ${decoded.currentStep.substring(0, decoded.currentStep.indexOf("\0"))}`,
    );
  }

  console.log(`[submit] Submit completed successfully.`);
}
