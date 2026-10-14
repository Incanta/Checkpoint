/**
 * Storage protocol 3: the server no longer merges store.lsi, so a client that
 * still expects it to is refused rather than half-served, and a submit can
 * only add blocks to the shared dedup index that its verified block map
 * vouches for.
 */
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createContext,
  createWorkspace,
  enabled,
  gatewayRequest,
  headChangelistNumber,
  nativeSubmit,
  storageToken,
  versionIndexOf,
  write,
  type IntegrationContext,
  type LocalWorkspace,
} from "./harness.js";

describe.skipIf(!enabled)("storage protocol gate", () => {
  let ctx: IntegrationContext;
  let ws: LocalWorkspace;

  beforeAll(async () => {
    ctx = await createContext("protocol-gate");
    ws = await createWorkspace(ctx, "protocol-gate");
  });

  afterAll(async () => {
    await ws?.cleanup();
  });

  it("refuses a storage token to a client that does not declare protocol 3", async () => {
    for (const clientProtocol of [undefined, 0, 2]) {
      await expect(
        ctx.client.storage.getToken.query({
          repoId: ctx.repoId,
          write: true,
          ...(clientProtocol !== undefined && { clientProtocol }),
        }),
        String(clientProtocol),
      ).rejects.toThrow(/too old/);
    }
  });

  async function post(form: FormData) {
    const { serverUrl, token } = await storageToken(ctx, true);
    const response = await fetch(`${serverUrl.replace(/\/$/, "")}/submit`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    return { status: response.status, text: await response.text() };
  }

  function payload(versionIndex: string, extra: Record<string, unknown> = {}) {
    return JSON.stringify({
      apiToken: ctx.apiToken,
      branchName: "main",
      message: "gate",
      versionIndex,
      modifications: [{ path: "gate/x.bin", delete: false }],
      keepCheckedOut: false,
      workspaceId: ws.workspaceId,
      ...extra,
    });
  }

  it("refuses a submit from a client before protocol 3 with 426", async () => {
    const form = new FormData();
    form.append("payload", payload(""));
    const response = await post(form);
    expect(response.status).toBe(426);
    expect(response.text).toMatch(/too old/);
  });

  it("refuses new blocks that the block map does not vouch for", async () => {
    await write(ws, "gate/one.bin", randomBytes(512 * 1024));
    const one = await nativeSubmit(ctx, ws, [{ path: "gate/one.bin", delete: false }]);
    await write(ws, "gate/two.bin", randomBytes(512 * 1024));
    const two = await nativeSubmit(ctx, ws, [{ path: "gate/two.bin", delete: false }]);
    expect(one.error, one.step).toBe(0);
    expect(two.error, two.step).toBe(0);
    const headBefore = await headChangelistNumber(ctx);

    const map = async (cl: number) => {
      const name = (await versionIndexOf(ctx, cl)).replace(/\.lvi$/, ".lsi");
      return (await gatewayRequest(ctx, "GET", `versions/${name}`)).body;
    };
    const versionTwo = await versionIndexOf(ctx, two.changelistNumber!);

    // Version two's genuine block map, but "new blocks" taken from version one.
    const form = new FormData();
    form.append("payload", payload(versionTwo, { protocol: 3, modifications: [{ path: "gate/two.bin", delete: false }] }));
    form.append("storeIndex", new Blob([new Uint8Array(await map(one.changelistNumber!))]), "chunk.bin");
    form.append("blockMap", new Blob([new Uint8Array(await map(two.changelistNumber!))]), "blockmap.lsi");
    const response = await post(form);

    expect(response.status).toBe(400);
    expect(response.text).toMatch(/does not match the block map/);
    expect(await headChangelistNumber(ctx)).toBe(headBefore);
  });

  it("refuses new content without a block map", async () => {
    const versionIndex = await versionIndexOf(ctx, await headChangelistNumber(ctx));
    const form = new FormData();
    form.append("payload", payload(versionIndex, { protocol: 3 }));
    form.append("storeIndex", new Blob([new Uint8Array(16)]), "chunk.bin");
    const response = await post(form);
    expect(response.status).toBe(400);
    expect(response.text).toMatch(/block map is required/);
  });
});
