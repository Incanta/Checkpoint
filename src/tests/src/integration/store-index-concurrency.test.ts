/**
 * The repo's store index (store.lsi) lists every block in storage. Clients
 * read it to decide which blocks they still have to upload, and every submit
 * adds its new blocks to it with a read, a merge, and a write on the server.
 *
 * Two of those interleaved used to be able to drop one submit's blocks from
 * the index. Nothing breaks straight away when that happens: the changelist is
 * readable, because the blocks are in storage. But the index no longer knows
 * about them, so every later submit of the same content uploads it again, and
 * anything that trusts the index as the list of what the repo holds is wrong.
 *
 * So the check here is deduplication: after several submits land at once,
 * submitting the same bytes again must upload no blocks at all.
 *
 * Needs a gateway storage mode (local or s3), which is what CI runs.
 */
import { randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createContext,
  createWorkspace,
  enabled,
  gatewayRequest,
  nativeSubmit,
  rawGatewayRequest,
  readCommitted,
  startFaultProxy,
  write,
  type FaultProxy,
  type IntegrationContext,
  type LocalWorkspace,
} from "./harness.js";

describe.skipIf(!enabled)("store index: concurrent submits", () => {
  let ctx: IntegrationContext;
  const workspaces: LocalWorkspace[] = [];
  let proxy: FaultProxy | undefined;

  const base = () => `/${ctx.orgId}/${ctx.repoId}`;

  beforeAll(async () => {
    ctx = await createContext("store-index-concurrency");
  });

  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
  });

  afterAll(async () => {
    await Promise.all(workspaces.map((ws) => ws.cleanup()));
  });

  async function workspace(name: string): Promise<LocalWorkspace> {
    const ws = await createWorkspace(ctx, name);
    workspaces.push(ws);
    return ws;
  }

  /** Submits `content` again under a new name and counts block uploads. */
  async function blockUploadsFor(content: Buffer, name: string) {
    const ws = await workspace(`again-${name}`);
    await write(ws, `${name}.bin`, content);
    proxy = await startFaultProxy(ctx, () => "pass");
    const outcome = await nativeSubmit(
      ctx,
      ws,
      [{ path: `${name}.bin`, delete: false }],
      "resubmit",
      { gatewayUrl: proxy.gatewayUrl },
    );
    expect(outcome.error).toBe(0);
    const uploads = proxy.requests.filter(
      (r) => r.method === "PUT" && r.path.includes("/chunks/"),
    ).length;
    await proxy.close();
    proxy = undefined;
    return uploads;
  }

  it("keeps every submit's blocks in the index when several land at once", async () => {
    const n = 6;
    const contents = Array.from({ length: n }, () =>
      randomBytes(300 * 1024),
    );
    const submitters = await Promise.all(
      contents.map(async (content, i) => {
        const ws = await workspace(`c${i}`);
        await write(ws, `file${i}.bin`, content);
        return ws;
      }),
    );

    const outcomes = await Promise.all(
      submitters.map((ws, i) =>
        nativeSubmit(ctx, ws, [{ path: `file${i}.bin`, delete: false }]),
      ),
    );

    for (const [i, outcome] of outcomes.entries()) {
      expect(outcome.step, `submit ${i}`).not.toContain("ailed");
      expect(outcome.error, `submit ${i}`).toBe(0);
    }
    expect(new Set(outcomes.map((o) => o.changelistNumber)).size).toBe(n);

    // Every changelist reads back as submitted.
    for (const [i, outcome] of outcomes.entries()) {
      const read = await readCommitted(
        ctx,
        outcome.changelistNumber!,
        `file${i}.bin`,
      );
      expect(read.equals(contents[i]!), `file${i}.bin`).toBe(true);
    }

    // And the index lists all of their blocks: none has to be uploaded again.
    for (const [i, content] of contents.entries()) {
      expect(await blockUploadsFor(content, `dup${i}`), `content ${i}`).toBe(0);
    }
  }, 240_000);

  it("uploads blocks for content the repo has never seen (control)", async () => {
    // Guards the assertion above: a count of zero only means something if new
    // content produces a count above zero.
    expect(await blockUploadsFor(randomBytes(300 * 1024), "fresh")).toBeGreaterThan(0);
  });

  it("leaves no lock or staging file behind", async () => {
    for (const name of ["store.lsi.sync", "store.lsi.next"]) {
      const head = await gatewayRequest(ctx, "HEAD", name);
      expect(head.status, name).toBe(404);
    }
    const index = await gatewayRequest(ctx, "GET", "store.lsi");
    expect(index.status).toBe(200);
    expect(index.body.length).toBeGreaterThan(0);
  });

  it("survives a second wave of concurrent submits on top of the first", async () => {
    const n = 4;
    const contents = Array.from({ length: n }, () => randomBytes(200 * 1024));
    const submitters = await Promise.all(
      contents.map(async (content, i) => {
        const ws = await workspace(`w${i}`);
        await write(ws, `wave${i}.bin`, content);
        return ws;
      }),
    );
    const outcomes = await Promise.all(
      submitters.map((ws, i) =>
        nativeSubmit(ctx, ws, [{ path: `wave${i}.bin`, delete: false }]),
      ),
    );
    for (const outcome of outcomes) {
      expect(outcome.error).toBe(0);
    }
    for (const [i, content] of contents.entries()) {
      expect(await blockUploadsFor(content, `wavedup${i}`), `content ${i}`).toBe(0);
    }
  }, 240_000);

  describe("gateway", () => {
    it("lets a client read the store index", async () => {
      const res = await rawGatewayRequest(ctx, "GET", `${base()}/store.lsi`, {
        write: false,
      });
      expect(res.status).toBe(200);
    });

    it.each([
      "store.lsi",
      "store.lsi.sync",
      "store.lsi.next",
      "STORE.LSI",
      "Store.Lsi.Sync",
    ])("does not let a client write or delete %s", async (name) => {
      const before = await rawGatewayRequest(ctx, "GET", `${base()}/store.lsi`);

      const put = await rawGatewayRequest(ctx, "PUT", `${base()}/${name}`, {
        body: randomBytes(64),
      });
      expect(put.status).toBe(403);

      const del = await rawGatewayRequest(ctx, "DELETE", `${base()}/${name}`);
      expect(del.status).toBe(403);

      const after = await rawGatewayRequest(ctx, "GET", `${base()}/store.lsi`);
      expect(after.status).toBe(200);
      expect(after.body.equals(before.body)).toBe(true);
    });

    it("still accepts a submit after those attempts", async () => {
      const ws = await workspace("after");
      const content = randomBytes(64 * 1024);
      await write(ws, "after.bin", content);
      const outcome = await nativeSubmit(ctx, ws, [
        { path: "after.bin", delete: false },
      ]);
      expect(outcome.error).toBe(0);
      const read = await readCommitted(ctx, outcome.changelistNumber!, "after.bin");
      expect(read.equals(content)).toBe(true);
    });
  });
});
