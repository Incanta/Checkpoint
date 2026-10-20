/**
 * The storage gateway's DELETE. Content blocks are shared by every changelist
 * that reuses them, so a client that could delete one could destroy data for
 * the whole repo with nothing more than a write token. Nothing a client does
 * needs that: blocks are written in place on object storage and never
 * renamed, and the server's leases and index files go to the backend
 * directly. The one client delete left is releasing a `<path>.lock` it took
 * (the addon's GatewayStorageAPI_UnlockFile).
 *
 * Runs the real gateway router against the local-disk backend in-process, so
 * it needs no services. The cross-repo and forgery cases are covered over
 * HTTP by src/integration/gateway-scope.test.ts.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import express from "express";
import njwt from "njwt";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { setConfig } from "../harness/config";
import { routeGateway } from "../../../core/server/src/routes/gateway.js";
import { storageSigningKey } from "../../../core/server/src/utils/signing-key.js";

// The server's logger reads its level from config at import time, which the
// fast suite does not provide.
vi.mock("../../../core/server/src/logging.js", () => ({
  Logger: {
    debug: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

const ORG = "orgdel";
const REPO = "repodel";
const BASE = `/${ORG}/${REPO}`;

function token(mode: "read" | "write"): string {
  const jwt = njwt.create(
    {
      iss: "checkpoint-vcs",
      sub: "u1",
      userId: "u1",
      orgId: ORG,
      repoId: REPO,
      mode,
      basePath: BASE,
    },
    storageSigningKey(),
  );
  jwt.setExpiration(Date.now() + 60_000);
  return jwt.compact();
}

describe("gateway DELETE", () => {
  let root: string;
  let server: Server;
  let url: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "chk-gateway-delete-"));
    const app = express();
    app.use("/storage", routeGateway());
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/storage`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    setConfig("storage.mode", "local");
    setConfig("storage.local.path", root);
  });

  async function plant(key: string): Promise<string> {
    const file = path.join(root, ...key.split("/").filter(Boolean));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "content");
    return file;
  }

  const del = (key: string, mode: "read" | "write" = "write") =>
    fetch(`${url}${key}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token(mode)}` },
    });

  it("refuses to delete a content block, even with a write token", async () => {
    const key = `${BASE}/chunks/ab12/0x00ab12cd34ef5678.lrb`;
    const file = await plant(key);

    const res = await del(key);
    expect(res.status).toBe(403);
    expect(existsSync(file)).toBe(true);
  });

  it("refuses to delete a block map or any other repo object", async () => {
    for (const key of [
      `${BASE}/versions/${"a".repeat(64)}.lbm`,
      `${BASE}/tree/${"b".repeat(64)}`,
      `${BASE}/anything.bin`,
    ]) {
      const file = await plant(key);
      const res = await del(key);
      expect(res.status, key).toBe(403);
      expect(existsSync(file), key).toBe(true);
    }
  });

  it("still lets a client release a lock it took (control)", async () => {
    const key = `${BASE}/chunks/ab12/0x00ab12cd34ef5678.lrb.lock`;
    const file = await plant(key);

    const res = await del(key);
    expect(res.status).toBe(204);
    expect(existsSync(file)).toBe(false);
  });

  it("does not let a read token release a lock (control)", async () => {
    const key = `${BASE}/held.lock`;
    const file = await plant(key);

    const res = await del(key, "read");
    expect(res.status).toBe(403);
    expect(existsSync(file)).toBe(true);
  });
});
