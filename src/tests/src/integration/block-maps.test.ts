/**
 * Per-version block maps (versions/<name>.lsi).
 *
 * A submit uploads, beside its version index, a store index naming the block
 * of every chunk in that version. Pulls and file reads can then find a
 * version's blocks without downloading the repo-wide store.lsi, which grows
 * with the repo. The server stores a map only after proving it covers every
 * chunk of the version and every block it names exists, because readers will
 * trust it; a submit whose map fails that is refused before anything is
 * recorded.
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

const mapNameFor = (versionIndex: string) => versionIndex.replace(/\.lvi$/, ".lsi");

describe.skipIf(!enabled)("block maps", () => {
  let ctx: IntegrationContext;
  let ws: LocalWorkspace;

  beforeAll(async () => {
    ctx = await createContext("block-maps");
    ws = await createWorkspace(ctx, "block-maps");
  });

  afterAll(async () => {
    await ws?.cleanup();
  });

  async function blockMapOf(changelistNumber: number): Promise<Buffer | null> {
    const versionIndex = await versionIndexOf(ctx, changelistNumber);
    const response = await gatewayRequest(ctx, "GET", `versions/${mapNameFor(versionIndex)}`);
    return response.status === 200 ? response.body : null;
  }

  it("stores a block map beside every submitted version", async () => {
    await write(ws, "a/big.bin", randomBytes(3 * 1024 * 1024));
    await write(ws, "a/small.txt", "hello\n");
    const outcome = await nativeSubmit(ctx, ws, [
      { path: "a/big.bin", delete: false },
      { path: "a/small.txt", delete: false },
    ]);
    expect(outcome.error, outcome.step).toBe(0);

    const map = await blockMapOf(outcome.changelistNumber!);
    expect(map).not.toBeNull();
    expect(map!.length).toBeGreaterThan(16);
  });

  it("stores one for a version made entirely of content the store already had", async () => {
    // Same bytes under a new name: every chunk deduplicates, nothing new is
    // uploaded, and the map must point at the earlier submit's blocks.
    const bytes = randomBytes(2 * 1024 * 1024);
    await write(ws, "dedup/original.bin", bytes);
    const first = await nativeSubmit(ctx, ws, [{ path: "dedup/original.bin", delete: false }]);
    expect(first.error, first.step).toBe(0);

    await write(ws, "dedup/copy.bin", bytes);
    const second = await nativeSubmit(ctx, ws, [{ path: "dedup/copy.bin", delete: false }]);
    expect(second.error, second.step).toBe(0);

    expect(await blockMapOf(second.changelistNumber!)).not.toBeNull();
  });

  it("refuses a submit whose block map does not cover its version, and records nothing", async () => {
    await write(ws, "forge/one.bin", randomBytes(1024 * 1024));
    const one = await nativeSubmit(ctx, ws, [{ path: "forge/one.bin", delete: false }]);
    await write(ws, "forge/two.bin", randomBytes(1024 * 1024));
    const two = await nativeSubmit(ctx, ws, [{ path: "forge/two.bin", delete: false }]);
    expect(one.error, one.step).toBe(0);
    expect(two.error, two.step).toBe(0);

    const headBefore = await headChangelistNumber(ctx);
    const versionTwo = await versionIndexOf(ctx, two.changelistNumber!);
    const mapOne = await blockMapOf(one.changelistNumber!);

    // Claim version two's index with version one's map, straight at /submit.
    const { serverUrl, token } = await storageToken(ctx, true);
    const form = new FormData();
    form.append(
      "payload",
      JSON.stringify({
        apiToken: ctx.apiToken,
        branchName: "main",
        message: "forged block map",
        versionIndex: versionTwo,
        modifications: [{ path: "forge/two.bin", delete: false }],
        keepCheckedOut: false,
        workspaceId: ws.workspaceId,
      }),
    );
    form.append("blockMap", new Blob([new Uint8Array(mapOne!)]), "blockmap.lsi");
    const response = await fetch(`${serverUrl.replace(/\/$/, "")}/submit`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/block map/i);
    expect(await headChangelistNumber(ctx)).toBe(headBefore);
  });

  it("refuses a block map that is not a store index at all", async () => {
    const versionIndex = await versionIndexOf(ctx, await headChangelistNumber(ctx));
    const { serverUrl, token } = await storageToken(ctx, true);
    const form = new FormData();
    form.append(
      "payload",
      JSON.stringify({
        apiToken: ctx.apiToken,
        branchName: "main",
        message: "garbage block map",
        versionIndex,
        modifications: [],
        keepCheckedOut: false,
        workspaceId: ws.workspaceId,
      }),
    );
    form.append("blockMap", new Blob([new Uint8Array(randomBytes(64))]), "blockmap.lsi");
    const response = await fetch(`${serverUrl.replace(/\/$/, "")}/submit`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    expect(response.status).toBe(400);
  });
});
