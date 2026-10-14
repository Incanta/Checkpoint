/**
 * POST /existing-content: the server answers which chunks the store already
 * has, from index segments it keeps in memory, so a submitting client no
 * longer downloads the repo-wide store.lsi to work it out.
 */
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createContext,
  createWorkspace,
  enabled,
  gatewayRequest,
  nativeSubmit,
  storageToken,
  versionIndexOf,
  write,
  type IntegrationContext,
  type LocalWorkspace,
} from "./harness.js";
import { hashesBuffer, readStoreIndex } from "./store-index-format.js";

function request(hashes: bigint[], minUsage: number): Buffer {
  const header = Buffer.alloc(20);
  header.write("CPEC", 0, "latin1");
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(0, 8);
  header.writeUInt32LE(minUsage, 12);
  header.writeUInt32LE(hashes.length, 16);
  return Buffer.concat([header, hashesBuffer(hashes)]);
}

describe.skipIf(!enabled)("existing content", () => {
  let ctx: IntegrationContext;
  let ws: LocalWorkspace;

  beforeAll(async () => {
    ctx = await createContext("existing-content");
    ws = await createWorkspace(ctx, "existing-content");
  });

  afterAll(async () => {
    await ws?.cleanup();
  });

  async function ask(body: Buffer, write = true) {
    const { serverUrl, token } = await storageToken(ctx, write);
    const response = await fetch(`${serverUrl.replace(/\/$/, "")}/existing-content`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
      body: new Uint8Array(body),
    });
    return {
      status: response.status,
      complete: response.headers.get("x-checkpoint-index"),
      body: Buffer.from(await response.arrayBuffer()),
    };
  }

  it("knows the chunks of what was submitted, and nothing else", async () => {
    await write(ws, "data/a.bin", randomBytes(3 * 1024 * 1024));
    const outcome = await nativeSubmit(ctx, ws, [{ path: "data/a.bin", delete: false }]);
    expect(outcome.error, outcome.step).toBe(0);

    // The version's own block map names its chunks.
    const versionIndex = await versionIndexOf(ctx, outcome.changelistNumber!);
    const map = await gatewayRequest(ctx, "GET", `versions/${versionIndex.replace(/\.lvi$/, ".lsi")}`);
    const chunks = readStoreIndex(map.body).blocks.flatMap((b) => b.chunks.map((c) => c.hash));
    expect(chunks.length).toBeGreaterThan(0);

    const known = await ask(request(chunks, 0));
    expect(known.status).toBe(200);
    expect(known.complete).toBe("complete");
    const answered = new Set(readStoreIndex(known.body).blocks.flatMap((b) => b.chunks.map((c) => c.hash)));
    for (const c of chunks) expect(answered.has(c)).toBe(true);

    const unknown = await ask(request([123n, 456n], 0));
    expect(unknown.status).toBe(200);
    expect(readStoreIndex(unknown.body).blocks).toEqual([]);
  });

  it("refuses a read token and a malformed request", async () => {
    expect((await ask(request([1n], 0), false)).status).toBe(403);
    expect((await ask(Buffer.from("nope"))).status).toBe(400);
    const lying = request([1n, 2n], 0).subarray(0, 28); // claims 2 hashes, carries 1
    expect((await ask(lying)).status).toBe(400);
  });

  it("does not let clients write or delete the server's index objects", async () => {
    for (const key of ["index/base.json", "index/seg/20260101/x.lsi", "INDEX/base.json"]) {
      expect((await gatewayRequest(ctx, "PUT", key, Buffer.from("forged"))).status, key).toBe(403);
      expect((await gatewayRequest(ctx, "DELETE", key)).status, key).toBe(403);
    }
  });
});
