import config from "@incanta/config";
import { ptr, toArrayBuffer } from "bun:ffi";
import {
  CreateLongtailLibrary,
  createStringBuffer,
  decodeHandle,
  GetLogLevel,
  type LongtailLogLevel,
  type Modification,
} from "@checkpointvcs/common";
import {
  getAuthToken,
  getWorkspaceState,
  saveWorkspaceState,
  type Workspace,
} from "./util";
import { createTRPCHTTPClient } from "@checkpointvcs/app-new/client";

export async function submit(
  workspace: Workspace,
  message: string,
  modifications: Modification[],
  logLevel: LongtailLogLevel = config.get<LongtailLogLevel>(
    "longtail.log-level"
  )
): Promise<void> {
  const apiToken = await getAuthToken();

  const client = createTRPCHTTPClient({
    url: `${config.get<string>("checkpoint.api.url")}/api/trpc`,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "auth-provider": "auth0",
    },
  });

  const storageTokenResponse = await client.storage.getToken.query({
    orgId: workspace.orgId,
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
      true
    );
    viewIndex += 8;

    if (modifications[i].oldPath) {
      modificationOldPathsBuffer.push(
        createStringBuffer(modifications[i].oldPath!)
      );
      view.setBigUint64(
        viewIndex,
        BigInt(ptr(modificationOldPathsBuffer[i].buffer)),
        true
      );
    } else {
      view.setBigUint64(viewIndex, BigInt(0), true);
    }
    viewIndex += 8;
  }

  const filerUrl = await fetch(`${backendUrl}/filer-url`).then((res) =>
    res.text()
  );

  const branchNameBuffer = createStringBuffer(workspace.branchName);
  const messageBuffer = createStringBuffer(message);
  const hashingAlgoBuffer = createStringBuffer(
    config.get<string>("longtail.hashing-algo")
  );
  const compressionAlgoBuffer = createStringBuffer(
    config.get<string>("longtail.compression-algo")
  );
  const localRootBuffer = createStringBuffer(workspace.localRoot);
  const remoteRootBuffer = createStringBuffer(
    `/${workspace.orgId}/${workspace.repoId}`
  );
  const filerUrlBuffer = createStringBuffer(filerUrl);
  const backendUrlBuffer = createStringBuffer(backendUrl);
  const tokenBuffer = createStringBuffer(token);
  const apiJwtBuffer = createStringBuffer(apiToken);

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
    ptr(localRootBuffer.buffer),
    ptr(remoteRootBuffer.buffer),
    ptr(filerUrlBuffer.buffer),
    ptr(backendUrlBuffer.buffer),
    ptr(tokenBuffer.buffer),
    tokenExpirationMs,
    ptr(apiJwtBuffer.buffer),
    modifications.length,
    ptr(buffer),
    GetLogLevel(logLevel)
  );

  if (asyncHandle === 0 || asyncHandle === null) {
    throw new Error("Failed to create longtail handle");
  }

  let flagForGC = true;
  let lastStep = "";

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const decoded = decodeHandle(
      new Uint8Array(toArrayBuffer(asyncHandle, 0, 272))
    );

    if (decoded.currentStep !== lastStep) {
      lastStep = decoded.currentStep;
    }

    if (decoded.completed) {
      if (decoded.error !== 0) {
        console.log(
          `Completed with exit code: ${decoded.error} and last step ${decoded.currentStep}`
        );
      }
      flagForGC = false;
      break;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }

  const decoded = decodeHandle(
    new Uint8Array(toArrayBuffer(asyncHandle, 0, 2320)),
    true
  );

  if (decoded.error === 0) {
    const workspaceState = await getWorkspaceState();

    for (const modification of modifications) {
      if (modification.delete) {
        delete workspaceState.files[modification.path];
      } else {
        workspaceState.files[modification.path] =
          decoded.result.changelistNumber;
      }
    }

    // we do not update the workspace state changelist number here
    // because they may need to sync other changes. we don't
    // auto pull during a push.

    await saveWorkspaceState(workspaceState);
  }

  if (flagForGC) {
    console.log(branchNameBuffer);
    console.log(messageBuffer);
    console.log(hashingAlgoBuffer);
    console.log(compressionAlgoBuffer);
    console.log(localRootBuffer);
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
      `Error submitting changes: ${decoded.error} ${decoded.currentStep}`
    );
  }
}
