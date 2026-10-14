/**
 * Leases in storage, which keep background work on a repo's shared objects
 * (block-map migration, index compaction) from running twice at once across
 * servers. They began as the lock around store.lsi merges; the old lock was a
 * file created after checking it was absent, which two holders could both do,
 * and which one that crashed left behind forever.
 *
 * These tests cover the replacement against the real local-disk backend: the
 * atomic create it is built on, exclusion inside one process, and the lease
 * that provides exclusion between processes and survives a holder dying.
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { setConfig } from "../harness/config";
import {
  getStorageBackend,
  type StorageBackend,
} from "../../../core/server/src/storage/backend.js";
import { withLease, type LeaseOptions } from "../../../core/server/src/storage/lease.js";

/** The lease for a repo's test key, as the server's background work takes one. */
const withRepoLease = <T,>(
  b: StorageBackend,
  base: string,
  fn: () => Promise<T>,
  options?: LeaseOptions,
) => withLease(b, `${base}/test.lease`, fn, options);

// The server's logger reads its level from config at import time, which the
// fast suite does not provide. Nothing here asserts on log output.
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("lease", () => {
  let root: string;
  let backend: StorageBackend;
  let repo: string;
  let counter = 0;

  const lockFile = () => path.join(root, repo, "test.lease");
  const lease = (token: string, renewedAt: number) =>
    JSON.stringify({ token, holder: "other-host:1", renewedAt });

  async function plantLock(content: string) {
    await mkdir(path.dirname(lockFile()), { recursive: true });
    await writeFile(lockFile(), content);
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "chk-index-lock-"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    setConfig("storage.mode", "local");
    setConfig("storage.local.path", root);
    backend = await getStorageBackend();
    repo = `/org${++counter}/repo`;
  });

  describe("putIfAbsent", () => {
    it("lets exactly one of many concurrent creators win, with its whole body", async () => {
      const key = `${repo}/claim`;
      const bodies = Array.from({ length: 24 }, (_, i) =>
        Buffer.from(`writer-${i}-`.repeat(2000)),
      );

      const results = await Promise.all(
        bodies.map((body) => backend.putIfAbsent(key, body)),
      );

      const winners = results.flatMap((won, i) => (won ? [i] : []));
      expect(winners.length).toBe(1);
      const stored = await backend.getBuffer(key);
      expect(stored!.equals(bodies[winners[0]!]!)).toBe(true);
    });

    it("leaves an existing object untouched", async () => {
      const key = `${repo}/claim`;
      expect(await backend.putIfAbsent(key, Buffer.from("first"))).toBe(true);
      expect(await backend.putIfAbsent(key, Buffer.from("second"))).toBe(false);
      expect((await backend.getBuffer(key))!.toString()).toBe("first");
    });

    it("can be taken again once the object is deleted", async () => {
      const key = `${repo}/claim`;
      expect(await backend.putIfAbsent(key, Buffer.from("a"))).toBe(true);
      await backend.delete(key);
      expect(await backend.putIfAbsent(key, Buffer.from("b"))).toBe(true);
    });

    it("leaves no temporary files behind", async () => {
      const key = `${repo}/claim`;
      await Promise.all(
        Array.from({ length: 8 }, () =>
          backend.putIfAbsent(key, Buffer.from("x")),
        ),
      );
      expect(await backend.sizeUnder(repo)).toBe(1);
    });
  });

  describe("inside one process", () => {
    it("never runs two holders for the same repo at once", async () => {
      // A read-modify-write with a gap in the middle: without the lock, most
      // of these increments are lost.
      const file = path.join(root, repo, "value");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "0");
      let active = 0;
      let maxActive = 0;

      await Promise.all(
        Array.from({ length: 30 }, () =>
          withRepoLease(backend, repo, async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            const value = Number(await readFile(file, "utf8"));
            await sleep(2);
            await writeFile(file, String(value + 1));
            active--;
          }),
        ),
      );

      expect(maxActive).toBe(1);
      expect(await readFile(file, "utf8")).toBe("30");
    });

    it("runs holders in the order they asked", async () => {
      const order: number[] = [];
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          withRepoLease(backend, repo, async () => {
            await sleep(3);
            order.push(i);
          }),
        ),
      );
      expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it("does not make one repo wait for another", async () => {
      let releaseA!: () => void;
      const holdA = new Promise<void>((resolve) => (releaseA = resolve));
      const a = withRepoLease(backend, `${repo}-a`, () => holdA);

      const started = Date.now();
      await withRepoLease(backend, `${repo}-b`, async () => {});
      expect(Date.now() - started).toBeLessThan(2000);

      releaseA();
      await a;
    });

    it("returns the value and releases the lock", async () => {
      const value = await withRepoLease(backend, repo, async () => 42);
      expect(value).toBe(42);
      expect(existsSync(lockFile())).toBe(false);
    });

    it("releases the lock when the holder throws, and the next holder runs", async () => {
      await expect(
        withRepoLease(backend, repo, async () => {
          throw new Error("merge failed");
        }),
      ).rejects.toThrow("merge failed");
      expect(existsSync(lockFile())).toBe(false);

      expect(await withRepoLease(backend, repo, async () => "ok")).toBe("ok");
    });

    it("holds a lease in storage while it runs", async () => {
      await withRepoLease(backend, repo, async () => {
        const held = JSON.parse(await readFile(lockFile(), "utf8"));
        expect(typeof held.token).toBe("string");
        expect(held.token.length).toBeGreaterThanOrEqual(32);
        expect(typeof held.holder).toBe("string");
        expect(Math.abs(Date.now() - held.renewedAt)).toBeLessThan(5000);
      });
    });
  });

  describe("against another server's lease", () => {
    it("waits while a live lease is held and proceeds once it is released", async () => {
      await plantLock(lease("someone-else", Date.now()));
      let ran = false;

      const pending = withRepoLease(
        backend,
        repo,
        async () => {
          ran = true;
        },
        { pollMs: 10, staleAfterMs: 60_000 },
      );

      await sleep(150);
      expect(ran).toBe(false);

      await rm(lockFile());
      await pending;
      expect(ran).toBe(true);
    });

    it("gives up after the acquire timeout without running, and leaves the lease alone", async () => {
      const theirs = lease("someone-else", Date.now());
      await plantLock(theirs);
      let ran = false;

      await expect(
        withRepoLease(
          backend,
          repo,
          async () => {
            ran = true;
          },
          { pollMs: 10, staleAfterMs: 60_000, acquireTimeoutMs: 120 },
        ),
      ).rejects.toThrow(/Timed out waiting for the lease/);

      expect(ran).toBe(false);
      expect(await readFile(lockFile(), "utf8")).toBe(theirs);
    });

    it("takes over a lease that has not been renewed", async () => {
      await plantLock(lease("dead-holder", Date.now() - 10 * 60_000));

      const value = await withRepoLease(backend, repo, async () => "ran", {
        pollMs: 10,
        staleAfterMs: 60_000,
      });

      expect(value).toBe("ran");
      expect(existsSync(lockFile())).toBe(false);
    });

    it.each([
      ["the old 4 byte lock", "lock"],
      ["an empty file", ""],
      ["truncated JSON", '{"token":"abc","renewedAt":'],
      ["JSON of the wrong shape", '{"hello":"world"}'],
      ["binary junk", "\u0000\u0001\u0002￿"],
    ])(
      "takes over %s, but only after the stale period",
      async (_name, content) => {
        // Left by a server from before leases, or by a crash mid-write. There
        // is no timestamp to trust, so it is timed from first sight.
        await plantLock(content);
        const started = Date.now();

        const value = await withRepoLease(
          backend,
          repo,
          async () => "ran",
          { pollMs: 10, staleAfterMs: 250 },
        );

        expect(value).toBe("ran");
        expect(Date.now() - started).toBeGreaterThanOrEqual(240);
        expect(existsSync(lockFile())).toBe(false);
      },
    );

    it("lets only one of several waiters take over a stale lease at a time", async () => {
      await plantLock(lease("dead-holder", Date.now() - 10 * 60_000));
      let active = 0;
      let maxActive = 0;

      // The first waiter has to break the dead lease; the rest must still run
      // one at a time behind it, and the last one out must leave no lock.
      await Promise.all(
        Array.from({ length: 12 }, () =>
          withRepoLease(
            backend,
            repo,
            async () => {
              active++;
              maxActive = Math.max(maxActive, active);
              await sleep(3);
              active--;
            },
            { pollMs: 5, staleAfterMs: 60_000 },
          ),
        ),
      );

      expect(maxActive).toBe(1);
      expect(existsSync(lockFile())).toBe(false);
    });

    it("renews its lease while it holds it", async () => {
      const seen: number[] = [];
      await withRepoLease(
        backend,
        repo,
        async () => {
          for (let i = 0; i < 4; i++) {
            seen.push(JSON.parse(await readFile(lockFile(), "utf8")).renewedAt);
            await sleep(80);
          }
        },
        { renewEveryMs: 25 },
      );

      expect(new Set(seen).size).toBeGreaterThan(1);
      expect(seen[seen.length - 1]!).toBeGreaterThan(seen[0]!);
    });

    it("does not delete a lease that was taken over from it", async () => {
      const theirs = lease("took-over", Date.now());

      await withRepoLease(backend, repo, async () => {
        // Another server judged this holder dead and took the lock.
        await writeFile(lockFile(), theirs);
      });

      expect(await readFile(lockFile(), "utf8")).toBe(theirs);
    });

    it("stops renewing once its lease is taken over", async () => {
      const theirs = lease("took-over", 12345);

      await withRepoLease(
        backend,
        repo,
        async () => {
          await writeFile(lockFile(), theirs);
          await sleep(150);
        },
        { renewEveryMs: 20 },
      );

      expect(await readFile(lockFile(), "utf8")).toBe(theirs);
    });
  });
});
