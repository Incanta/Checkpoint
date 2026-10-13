/**
 * A changelist records the name of its version index and nothing else about
 * it, so whatever is stored under that name is the changelist's content.
 *
 * The name used to be a pointer value printed in hex ("0x<address>.lvi").
 * Addresses repeat, between processes and within one, so a later submit could
 * be handed a name an earlier changelist already used and silently replace
 * that changelist's content with its own.
 *
 * The name is now the SHA-256 of the index bytes, and that is enforced at
 * every step:
 *
 *   - the gateway stores a version index only under the hash of its body,
 *     never replaces one, and never deletes one for a client;
 *   - the server recomputes the hash before it creates the changelist;
 *   - the addon recomputes it when it reads an index, so a pull cannot be
 *     served something else.
 *
 * Needs a gateway storage mode (local or s3), which is what CI runs.
 */
import { createHash, randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Modification } from "@checkpointvcs/longtail-addon";

import {
  createContext,
  createWorkspace,
  enabled,
  gatewayRequest,
  headChangelistNumber,
  nativeSubmit,
  readCommitted,
  startFaultProxy,
  versionIndexOf,
  write,
  type FaultProxy,
  type IntegrationContext,
  type LocalWorkspace,
} from "./harness.js";

const add = (filePath: string): Modification => ({
  path: filePath,
  delete: false,
});

const CONTENT_NAME = /^[0-9a-f]{64}\.lvi$/;
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

describe.skipIf(!enabled)("version index: content addressed names", () => {
  let ctx: IntegrationContext;
  let ws: LocalWorkspace | undefined;
  let proxy: FaultProxy | undefined;

  beforeAll(async () => {
    ctx = await createContext("version-index-integrity");
  });

  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
    await ws?.cleanup();
    ws = undefined;
  });

  afterAll(async () => {
    await ws?.cleanup();
  });

  /** Submits one file and returns the changelist and its stored index. */
  async function submitFile(name: string, content: Buffer) {
    ws ??= await createWorkspace(ctx, "vi");
    await write(ws, name, content);
    const outcome = await nativeSubmit(ctx, ws, [add(name)]);
    expect(outcome.step).not.toContain("ailed");
    expect(outcome.error).toBe(0);
    const number = outcome.changelistNumber!;
    const indexName = await versionIndexOf(ctx, number);
    const stored = await gatewayRequest(ctx, "GET", `versions/${indexName}`);
    expect(stored.status).toBe(200);
    return { number, indexName, bytes: stored.body };
  }

  it("names the index after the SHA-256 of its bytes", async () => {
    const cl = await submitFile("a.bin", randomBytes(4096));

    expect(cl.indexName).toMatch(CONTENT_NAME);
    expect(cl.indexName).toBe(`${sha256(cl.bytes)}.lvi`);
  });

  it("gives different submits different names and leaves earlier indexes untouched", async () => {
    const first = await submitFile("b.bin", randomBytes(4096));
    const second = await submitFile("b.bin", randomBytes(4096));
    const third = await submitFile("c.bin", randomBytes(4096));

    expect(new Set([first.indexName, second.indexName, third.indexName]).size).toBe(3);

    const firstAgain = await gatewayRequest(ctx, "GET", `versions/${first.indexName}`);
    expect(firstAgain.body.equals(first.bytes)).toBe(true);
  });

  it("keeps every changelist readable when a file flips between the same two contents", async () => {
    // Changelists 1 and 3 (and 2 and 4) carry identical deltas, so they hash
    // to the same index. Sharing it is correct; losing either would not be.
    const x = randomBytes(8192);
    const y = randomBytes(8192);

    const cls = [];
    for (const content of [x, y, x, y]) {
      cls.push(await submitFile("flip.bin", content));
    }

    expect(cls[2]!.indexName).toBe(cls[0]!.indexName);
    expect(cls[3]!.indexName).toBe(cls[1]!.indexName);
    expect(cls[1]!.indexName).not.toBe(cls[0]!.indexName);
    expect(new Set(cls.map((c) => c.number)).size).toBe(4);

    const expected = [x, y, x, y];
    for (let i = 0; i < cls.length; i++) {
      const read = await readCommitted(ctx, cls[i]!.number, "flip.bin");
      expect(read.equals(expected[i]!)).toBe(true);
    }
  });

  it("submits an empty file and a delete-only changelist", async () => {
    const empty = await submitFile("empty.bin", Buffer.alloc(0));
    expect(empty.indexName).toMatch(CONTENT_NAME);

    const outcome = await nativeSubmit(ctx, ws!, [
      { path: "empty.bin", delete: true },
    ]);
    expect(outcome.error).toBe(0);
    const indexName = await versionIndexOf(ctx, outcome.changelistNumber!);
    // A delete-only submit may carry no index at all; if it does, it is named
    // like any other.
    if (indexName) {
      expect(indexName).toMatch(CONTENT_NAME);
    }
  });

  describe("gateway", () => {
    it("refuses a version index whose body does not hash to its name", async () => {
      const body = randomBytes(512);
      const wrongName = `${sha256(randomBytes(32))}.lvi`;

      const put = await gatewayRequest(ctx, "PUT", `versions/${wrongName}`, body);
      expect(put.status).toBe(400);

      const head = await gatewayRequest(ctx, "HEAD", `versions/${wrongName}`);
      expect(head.status).toBe(404);
    });

    it("stores a version index whose body does hash to its name", async () => {
      const body = randomBytes(512);
      const name = `${sha256(body)}.lvi`;

      const put = await gatewayRequest(ctx, "PUT", `versions/${name}`, body);
      expect(put.status).toBe(201);

      const get = await gatewayRequest(ctx, "GET", `versions/${name}`);
      expect(get.body.equals(body)).toBe(true);
    });

    it.each([
      "0x1f3a5c0.lvi",
      "0x000001c8f2a41040.lvi",
      "latest.lvi",
      `${"A".repeat(64)}.lvi`,
      `${"a".repeat(63)}.lvi`,
      `${"a".repeat(64)}.txt`,
      `${"a".repeat(64)}`,
    ])("refuses the name %s", async (name) => {
      const put = await gatewayRequest(ctx, "PUT", `versions/${name}`, randomBytes(64));
      expect(put.status).toBe(400);

      const head = await gatewayRequest(ctx, "HEAD", `versions/${name}`);
      expect(head.status).toBe(404);
    });

    it("does not replace an index that is already stored", async () => {
      const cl = await submitFile("keep.bin", randomBytes(4096));

      const put = await gatewayRequest(ctx, "PUT", `versions/${cl.indexName}`, randomBytes(cl.bytes.length));
      // Reported as already there, which is what a retried upload needs.
      expect(put.status).toBe(200);

      const after = await gatewayRequest(ctx, "GET", `versions/${cl.indexName}`);
      expect(after.body.equals(cl.bytes)).toBe(true);
    });

    it("accepts a repeat upload of the same index", async () => {
      const cl = await submitFile("again.bin", randomBytes(4096));

      const put = await gatewayRequest(ctx, "PUT", `versions/${cl.indexName}`, cl.bytes);
      expect(put.status).toBe(200);

      const after = await gatewayRequest(ctx, "GET", `versions/${cl.indexName}`);
      expect(after.body.equals(cl.bytes)).toBe(true);
    });

    it("does not let a client delete a version index", async () => {
      const content = randomBytes(4096);
      const cl = await submitFile("nodelete.bin", content);

      const del = await gatewayRequest(ctx, "DELETE", `versions/${cl.indexName}`);
      expect(del.status).toBe(403);

      const read = await readCommitted(ctx, cl.number, "nodelete.bin");
      expect(read.equals(content)).toBe(true);
    });
  });

  describe("reading", () => {
    /** Reads through a proxy that serves `served` in place of the index. */
    async function readWithIndex(number: number, file: string, served: Buffer) {
      proxy = await startFaultProxy(ctx, (r) =>
        r.path.includes("/versions/") ? { respond: served } : "pass",
      );
      return readCommitted(ctx, number, file, 20, {
        gatewayUrl: proxy.gatewayUrl,
      });
    }

    it("reads normally through the proxy (control)", async () => {
      const content = randomBytes(4096);
      const cl = await submitFile("control.bin", content);

      const read = await readWithIndex(cl.number, "control.bin", cl.bytes);
      expect(read.equals(content)).toBe(true);
    });

    it("rejects an index with one flipped bit", async () => {
      const cl = await submitFile("flipped.bin", randomBytes(4096));
      const tampered = Buffer.from(cl.bytes);
      tampered[tampered.length - 1]! ^= 0x01;

      await expect(readWithIndex(cl.number, "flipped.bin", tampered)).rejects.toThrow();
    });

    it("rejects another changelist's index served under this name", async () => {
      // The substitution the old naming made possible: a valid index, for the
      // same path, that belongs to a different changelist.
      const original = randomBytes(4096);
      const first = await submitFile("swap.bin", original);
      const second = await submitFile("swap.bin", randomBytes(4096));

      await expect(readWithIndex(first.number, "swap.bin", second.bytes)).rejects.toThrow();

      await proxy?.close();
      proxy = undefined;
      const read = await readCommitted(ctx, first.number, "swap.bin");
      expect(read.equals(original)).toBe(true);
    });

    it("rejects a truncated index and an empty one", async () => {
      const cl = await submitFile("short.bin", randomBytes(4096));

      await expect(
        readWithIndex(cl.number, "short.bin", cl.bytes.subarray(0, cl.bytes.length - 8)),
      ).rejects.toThrow();

      await proxy?.close();
      await expect(readWithIndex(cl.number, "short.bin", Buffer.alloc(0))).rejects.toThrow();
    });
  });

  describe("submit endpoint", () => {
    it("refuses a submit when the index never reached storage, and the head does not move", async () => {
      ws = await createWorkspace(ctx, "vi-swallow");
      await write(ws, "ghost.bin", randomBytes(4096));
      const before = await headChangelistNumber(ctx);

      proxy = await startFaultProxy(ctx, (r) =>
        r.method === "PUT" && r.path.includes("/versions/") ? "swallow" : "pass",
      );
      const outcome = await nativeSubmit(ctx, ws, [add("ghost.bin")], "ghost", {
        gatewayUrl: proxy.gatewayUrl,
      });

      expect(outcome.error).not.toBe(0);
      expect(await headChangelistNumber(ctx)).toBe(before);
    });
  });
});
