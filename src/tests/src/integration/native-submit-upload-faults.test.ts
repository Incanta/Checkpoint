/**
 * A changelist must never exist unless its data is in storage.
 *
 * The addon uploads blocks and the version index itself, then asks the server
 * to create the changelist. Both halves of that used to trust the upload:
 *
 *   - The storage adapters upload from CloseFile, which returns void, so a PUT
 *     that failed was logged and forgotten. Longtail reported success and the
 *     submit went on to create a changelist with nothing behind it.
 *   - The server created the changelist from the names it was given without
 *     looking in storage, and merged the client's list of "new blocks" into
 *     the repo's store index unchecked. A block listed there but absent from
 *     the store poisons every later submit that shares its content: the
 *     client sees the block in the index, skips the upload, and commits
 *     another unreadable changelist.
 *
 * These tests put a proxy between the addon and the storage gateway and break
 * uploads in the ways a network does (errors, dropped connections) and in the
 * way only a broken or dishonest client can (reporting success for an upload
 * that never happened). The contract in every case: the submit fails, the
 * branch head does not move, and an honest retry afterwards works.
 *
 * Needs a gateway storage mode (local or s3), which is what CI runs. In r2
 * mode the client talks to the bucket directly and there is nothing to proxy.
 */
import { randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Modification } from "@checkpointvcs/longtail-addon";

import {
  createContext,
  createWorkspace,
  enabled,
  headChangelistNumber,
  nativeSubmit,
  readCommitted,
  startFaultProxy,
  write,
  type FaultProxy,
  type FaultRequest,
  type IntegrationContext,
  type LocalWorkspace,
} from "./harness.js";

const add = (filePath: string): Modification => ({
  path: filePath,
  delete: false,
});

const isBlockPut = (r: FaultRequest) =>
  r.method === "PUT" && r.path.includes("/chunks/");
const isVersionIndexPut = (r: FaultRequest) =>
  r.method === "PUT" && r.path.includes("/versions/");

// Random bytes, so no block can already be in the store from another test. A
// block the store already has is never uploaded, and then there would be no
// upload to break.
const freshContent = (size = 64 * 1024) => randomBytes(size);

describe.skipIf(!enabled)("native submit: uploads that fail", () => {
  let ctx: IntegrationContext;
  let ws: LocalWorkspace | undefined;
  let proxy: FaultProxy | undefined;

  beforeAll(async () => {
    ctx = await createContext("native-upload-faults");
  });

  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
    await ws?.cleanup();
    ws = undefined;
  });

  afterAll(async () => {
    await proxy?.close();
    await ws?.cleanup();
  });

  const submitThroughProxy = (modifications: Modification[]) =>
    nativeSubmit(ctx, ws!, modifications, "upload fault test", {
      gatewayUrl: proxy!.gatewayUrl,
    });

  it("commits normally through the proxy when nothing is broken", async () => {
    // The control. If this fails, the proxy is at fault and every other result
    // in this file means nothing.
    ws = await createWorkspace(ctx, "control");
    const content = freshContent();
    await write(ws, "Control.bin", content);
    proxy = await startFaultProxy(ctx, () => "pass");

    const outcome = await submitThroughProxy([add("Control.bin")]);

    expect(outcome.error, outcome.step).toBe(0);
    expect(proxy.requests.some(isBlockPut)).toBe(true);
    expect(proxy.requests.some(isVersionIndexPut)).toBe(true);
    const committed = await readCommitted(
      ctx,
      outcome.changelistNumber!,
      "Control.bin",
    );
    expect(committed.equals(content)).toBe(true);
  });

  it("fails the submit when a block upload keeps getting a server error", async () => {
    ws = await createWorkspace(ctx, "block-500");
    await write(ws, "Data.bin", freshContent());
    proxy = await startFaultProxy(ctx, (r) =>
      isBlockPut(r) ? { status: 500 } : "pass",
    );
    const before = await headChangelistNumber(ctx);

    const outcome = await submitThroughProxy([add("Data.bin")]);

    expect(
      outcome.error,
      "a block that never reached storage must fail the submit",
    ).not.toBe(0);
    expect(outcome.step).toContain("Upload failed");
    expect(outcome.step).toContain("/chunks/");
    expect(await headChangelistNumber(ctx)).toBe(before);
    // A server error is worth retrying, and it was retried before giving up.
    expect(proxy.requests.filter(isBlockPut).length).toBeGreaterThan(1);
    // Nothing after the failed block may run: no version index was written.
    expect(proxy.requests.some(isVersionIndexPut)).toBe(false);
  });

  it("fails the submit when the connection drops on every block upload", async () => {
    ws = await createWorkspace(ctx, "block-reset");
    await write(ws, "Data.bin", freshContent());
    proxy = await startFaultProxy(ctx, (r) => (isBlockPut(r) ? "reset" : "pass"));
    const before = await headChangelistNumber(ctx);

    const outcome = await submitThroughProxy([add("Data.bin")]);

    expect(outcome.error).not.toBe(0);
    expect(outcome.step).toContain("Upload failed");
    expect(await headChangelistNumber(ctx)).toBe(before);
  });

  it("fails without retrying when the store refuses a block outright", async () => {
    // A 403 means the request itself is wrong (bad token, wrong repo). Trying
    // again cannot fix it, and must not be mistaken for success either.
    ws = await createWorkspace(ctx, "block-403");
    await write(ws, "Data.bin", freshContent());
    proxy = await startFaultProxy(ctx, (r) =>
      isBlockPut(r) ? { status: 403 } : "pass",
    );
    const before = await headChangelistNumber(ctx);

    const outcome = await submitThroughProxy([add("Data.bin")]);

    expect(outcome.error).not.toBe(0);
    expect(outcome.step).toContain("HTTP 403");
    expect(await headChangelistNumber(ctx)).toBe(before);
    expect(proxy.requests.filter(isBlockPut).length).toBe(1);
  });

  it("fails the submit when only one block of several cannot be uploaded", async () => {
    // Large enough to split into several blocks, with a single one refused.
    // One missing block corrupts the file just as surely as all of them, and
    // it is the case a "did anything fail" shortcut is most likely to miss.
    ws = await createWorkspace(ctx, "one-of-many");
    await write(ws, "Large.bin", freshContent(20 * 1024 * 1024));
    let refused: string | undefined;
    proxy = await startFaultProxy(ctx, (r) => {
      if (!isBlockPut(r)) return "pass";
      refused ??= r.path;
      return r.path === refused ? { status: 403 } : "pass";
    });
    const before = await headChangelistNumber(ctx);

    const outcome = await submitThroughProxy([add("Large.bin")]);

    const blockPaths = new Set(
      proxy.requests.filter(isBlockPut).map((r) => r.path),
    );
    expect(blockPaths.size, "the file should span several blocks").toBeGreaterThan(1);
    expect(outcome.error).not.toBe(0);
    expect(await headChangelistNumber(ctx)).toBe(before);
  });

  it("survives the handle being freed the moment a failed submit completes, repeatedly", async () => {
    // A failed submit reports its outcome while other blocks are still in
    // flight and the storage APIs are still being torn down. The caller frees
    // the handle as soon as it sees "completed", so if that flag goes up
    // before the worker is done with the handle, the process dies in native
    // code (it did, intermittently: exit 0xC0000409). There is nothing to
    // assert on a crash except that this test, and the ones after it, ran.
    ws = await createWorkspace(ctx, "free-on-complete");
    let refused: string | undefined;
    proxy = await startFaultProxy(ctx, (r) => {
      if (!isBlockPut(r)) return "pass";
      refused ??= r.path;
      return r.path === refused ? { status: 403 } : "pass";
    });
    const before = await headChangelistNumber(ctx);

    for (let round = 0; round < 6; round++) {
      refused = undefined;
      await write(ws, "Large.bin", freshContent(18 * 1024 * 1024));
      const outcome = await submitThroughProxy([add("Large.bin")]);
      expect(outcome.error, `round ${round}`).not.toBe(0);
    }

    expect(await headChangelistNumber(ctx)).toBe(before);
  }, 240_000);

  it("recovers when a block upload fails twice and then goes through", async () => {
    // A blip must not fail the submit, and the retried upload must carry the
    // whole block: the bytes read back are compared, not just the outcome.
    ws = await createWorkspace(ctx, "transient");
    const content = freshContent();
    await write(ws, "Data.bin", content);
    proxy = await startFaultProxy(ctx, (r) => {
      if (!isBlockPut(r)) return "pass";
      if (r.attempt === 1) return "reset";
      if (r.attempt === 2) return { status: 503 };
      return "pass";
    });

    const outcome = await submitThroughProxy([add("Data.bin")]);

    expect(outcome.error, outcome.step).toBe(0);
    const committed = await readCommitted(
      ctx,
      outcome.changelistNumber!,
      "Data.bin",
    );
    expect(committed.equals(content)).toBe(true);
  });

  it("fails the submit when the version index cannot be uploaded", async () => {
    // The blocks are all there; the index naming them is not. Without the
    // index the changelist cannot be read at all.
    ws = await createWorkspace(ctx, "index-fails");
    await write(ws, "Data.bin", freshContent());
    proxy = await startFaultProxy(ctx, (r) =>
      isVersionIndexPut(r) ? "reset" : "pass",
    );
    const before = await headChangelistNumber(ctx);

    const outcome = await submitThroughProxy([add("Data.bin")]);

    expect(outcome.error).not.toBe(0);
    expect(outcome.step).toContain("Upload failed");
    expect(outcome.step).toContain("/versions/");
    expect(await headChangelistNumber(ctx)).toBe(before);
  });

  it("recovers when the version index upload fails once and then goes through", async () => {
    ws = await createWorkspace(ctx, "index-transient");
    const content = freshContent();
    await write(ws, "Data.bin", content);
    proxy = await startFaultProxy(ctx, (r) =>
      isVersionIndexPut(r) && r.attempt === 1 ? { status: 502 } : "pass",
    );

    const outcome = await submitThroughProxy([add("Data.bin")]);

    expect(outcome.error, outcome.step).toBe(0);
    const committed = await readCommitted(
      ctx,
      outcome.changelistNumber!,
      "Data.bin",
    );
    expect(committed.equals(content)).toBe(true);
  });

  it("leaves an honest retry working after a failed submit", async () => {
    // The failed attempt must leave nothing behind that makes the next one
    // skip its uploads. Same workspace, same bytes, proxy now healthy.
    ws = await createWorkspace(ctx, "retry-after-failure");
    const content = freshContent();
    await write(ws, "Data.bin", content);
    proxy = await startFaultProxy(ctx, (r) =>
      isBlockPut(r) ? { status: 403 } : "pass",
    );
    const failed = await submitThroughProxy([add("Data.bin")]);
    expect(failed.error).not.toBe(0);

    const retried = await nativeSubmit(ctx, ws, [add("Data.bin")]);

    expect(retried.error, retried.step).toBe(0);
    const committed = await readCommitted(
      ctx,
      retried.changelistNumber!,
      "Data.bin",
    );
    expect(committed.equals(content)).toBe(true);
  });
});

describe.skipIf(!enabled)(
  "submit endpoint: uploads the client only claims to have made",
  () => {
    let ctx: IntegrationContext;
    let ws: LocalWorkspace | undefined;
    let proxy: FaultProxy | undefined;

    beforeAll(async () => {
      ctx = await createContext("submit-unverified");
    });

    afterEach(async () => {
      await proxy?.close();
      proxy = undefined;
      await ws?.cleanup();
      ws = undefined;
    });

    afterAll(async () => {
      await proxy?.close();
      await ws?.cleanup();
    });

    const submitThroughProxy = (modifications: Modification[]) =>
      nativeSubmit(ctx, ws!, modifications, "unverified upload test", {
        gatewayUrl: proxy!.gatewayUrl,
      });

    it("refuses a changelist whose block is not in storage", async () => {
      ws = await createWorkspace(ctx, "block-missing");
      await write(ws, "Data.bin", freshContent());
      proxy = await startFaultProxy(ctx, (r) =>
        isBlockPut(r) ? "swallow" : "pass",
      );
      const before = await headChangelistNumber(ctx);

      const outcome = await submitThroughProxy([add("Data.bin")]);

      expect(
        outcome.error,
        "the server must not create a changelist for a block it cannot find",
      ).not.toBe(0);
      expect(outcome.step).toContain("not in storage");
      expect(await headChangelistNumber(ctx)).toBe(before);
    });

    it("does not record a missing block in the store index", async () => {
      // The poisoning case. If the refused submit's block list had been merged
      // into the store index anyway, this honest resubmit of the same bytes
      // would find the block "already stored", upload nothing, and commit a
      // changelist that cannot be read.
      ws = await createWorkspace(ctx, "no-poison");
      const content = freshContent();
      await write(ws, "Data.bin", content);
      proxy = await startFaultProxy(ctx, (r) =>
        isBlockPut(r) ? "swallow" : "pass",
      );
      const refused = await submitThroughProxy([add("Data.bin")]);
      expect(refused.error).not.toBe(0);
      await proxy.close();

      proxy = await startFaultProxy(ctx, () => "pass");
      const honest = await submitThroughProxy([add("Data.bin")]);

      expect(honest.error, honest.step).toBe(0);
      expect(
        proxy.requests.some(isBlockPut),
        "the resubmit must upload the block the store never received",
      ).toBe(true);
      const committed = await readCommitted(
        ctx,
        honest.changelistNumber!,
        "Data.bin",
      );
      expect(committed.equals(content)).toBe(true);
    });

    it("refuses a changelist when one block of several is not in storage", async () => {
      ws = await createWorkspace(ctx, "one-block-missing");
      await write(ws, "Large.bin", freshContent(20 * 1024 * 1024));
      let dropped: string | undefined;
      proxy = await startFaultProxy(ctx, (r) => {
        if (!isBlockPut(r)) return "pass";
        dropped ??= r.path;
        return r.path === dropped ? "swallow" : "pass";
      });
      const before = await headChangelistNumber(ctx);

      const outcome = await submitThroughProxy([add("Large.bin")]);

      expect(outcome.error).not.toBe(0);
      expect(outcome.step).toContain("not in storage");
      expect(await headChangelistNumber(ctx)).toBe(before);
    });

    it("refuses a changelist whose version index is not in storage", async () => {
      ws = await createWorkspace(ctx, "index-missing");
      await write(ws, "Data.bin", freshContent());
      proxy = await startFaultProxy(ctx, (r) =>
        isVersionIndexPut(r) ? "swallow" : "pass",
      );
      const before = await headChangelistNumber(ctx);

      const outcome = await submitThroughProxy([add("Data.bin")]);

      expect(outcome.error).not.toBe(0);
      expect(outcome.step).toContain("not in storage");
      expect(await headChangelistNumber(ctx)).toBe(before);
    });
  },
);
