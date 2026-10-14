import { randomBytes } from "crypto";
import os from "os";
import type { StorageBackend } from "./backend.js";
import { Logger } from "../logging.js";

// A lease in storage: mutual exclusion for work on a repo's shared objects,
// across every core server that shares the store.
//
// It used to guard the read-merge-write of the repo-wide store.lsi on every
// submit. Since storage protocol 3 submits write immutable index segments
// with no lock at all, and leases guard only background work that must not
// run twice at once: the one-time block-map migration and index compaction.
//
// The old lock was a file created after checking it was not there. Two
// holders could both pass the check, and one that died left the file behind
// for good. Two layers now:
//
//   1. A queue per key inside this process, which on its own is a complete,
//      fair lock for a single server.
//   2. A lease in storage for several servers. It is created atomically
//      (create-if-absent), names its holder, is renewed while held, and can be
//      taken over once it has gone unrenewed long enough that its holder must
//      be dead.

export interface LeaseOptions {
  /** A lease not renewed for this long belongs to a dead holder. */
  staleAfterMs?: number;
  /** How often a held lease is renewed. */
  renewEveryMs?: number;
  /** Give up waiting for the lock after this long. */
  acquireTimeoutMs?: number;
  /** Delay between attempts while someone else holds the lease. */
  pollMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

const DEFAULTS = {
  staleAfterMs: 2 * 60_000,
  renewEveryMs: 20_000,
  acquireTimeoutMs: 15 * 60_000,
  pollMs: 150,
};

interface Lease {
  token: string;
  holder: string;
  renewedAt: number;
}

function parseLease(raw: Buffer | null): Lease | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as Partial<Lease>;
    if (
      typeof parsed.token === "string" &&
      typeof parsed.renewedAt === "number"
    ) {
      return {
        token: parsed.token,
        holder: typeof parsed.holder === "string" ? parsed.holder : "unknown",
        renewedAt: parsed.renewedAt,
      };
    }
  } catch {
    // Not one of ours: see firstSeen in acquireLease.
  }
  return null;
}

function leaseBody(token: string, now: number): Buffer {
  const lease: Lease = {
    token,
    holder: `${os.hostname()}:${process.pid}`,
    renewedAt: now,
  };
  return Buffer.from(JSON.stringify(lease), "utf8");
}

// One queue per lock key. The stored promise settles when the last holder
// queued so far has released.
const queues = new Map<string, Promise<void>>();

async function withQueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  queues.set(key, tail);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    // Drop the entry once nobody is queued behind us, so the map does not
    // grow by one promise per repo forever.
    if (queues.get(key) === tail) {
      queues.delete(key);
    }
  }
}

async function acquireLease(
  backend: StorageBackend,
  lockKey: string,
  token: string,
  opts: Required<Omit<LeaseOptions, "now">> & { now: () => number },
): Promise<void> {
  const deadline = opts.now() + opts.acquireTimeoutMs;
  // A lock file with content we cannot read was written by a server from
  // before leases existed, which never recorded when it took the lock. Time it
  // from when we first saw it.
  let unreadableSince: number | null = null;

  for (;;) {
    if (await backend.putIfAbsent(lockKey, leaseBody(token, opts.now()))) {
      return;
    }

    const raw = await backend.getBuffer(lockKey);
    if (raw === null) {
      // Released between the two calls; try again at once.
      continue;
    }

    const lease = parseLease(raw);
    const now = opts.now();
    let stale: boolean;
    if (lease) {
      unreadableSince = null;
      stale = now - lease.renewedAt > opts.staleAfterMs;
    } else {
      unreadableSince ??= now;
      stale = now - unreadableSince > opts.staleAfterMs;
    }

    if (stale) {
      Logger.warn(
        `[Lease] Taking over a stale lock at ${lockKey} (held by ${
          lease?.holder ?? "an older server"
        })`,
      );
      // Remove it only if it is still the lease we judged stale, then go
      // around again and compete for it like anyone else. Two servers can both
      // get here; only one of their create-if-absent calls will succeed.
      const current = await backend.getBuffer(lockKey);
      if (current !== null && current.equals(raw)) {
        await backend.delete(lockKey);
      }
      unreadableSince = null;
      continue;
    }

    if (now >= deadline) {
      throw new Error(
        `Timed out waiting for the lease at ${lockKey} (held by ${
          lease?.holder ?? "an older server"
        })`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs));
  }
}

/**
 * Runs `fn` holding the lease at `lockKey` (a storage key). Nothing else
 * holding the same key, in this process or another server, runs at the same
 * time. Throws, without running `fn`, if the lease cannot be had within
 * `acquireTimeoutMs`.
 */
export async function withLease<T>(
  backend: StorageBackend,
  lockKey: string,
  fn: () => Promise<T>,
  options: LeaseOptions = {},
): Promise<T> {
  const opts = {
    ...DEFAULTS,
    ...options,
    now: options.now ?? Date.now,
  };
  return withQueue(lockKey, async () => {
    const token = randomBytes(16).toString("hex");
    await acquireLease(backend, lockKey, token, opts);

    let lost = false;
    const renew = setInterval(() => {
      void (async () => {
        try {
          const current = parseLease(await backend.getBuffer(lockKey));
          if (current?.token !== token) {
            // Taken over: we were judged dead. Stop touching the file.
            lost = true;
            clearInterval(renew);
            return;
          }
          const body = leaseBody(token, opts.now());
          await backend.put(lockKey, body, body.length);
        } catch (err) {
          Logger.warn(`[Lease] Could not renew ${lockKey}: ${err}`);
        }
      })();
    }, opts.renewEveryMs);
    renew.unref?.();

    try {
      return await fn();
    } finally {
      clearInterval(renew);
      try {
        // Release only our own lease. If it was taken over, the file now
        // belongs to someone else.
        const current = parseLease(await backend.getBuffer(lockKey));
        if (!lost && current?.token === token) {
          await backend.delete(lockKey);
        }
      } catch (err) {
        // The lease will go stale and be taken over.
        Logger.warn(`[Lease] Could not release ${lockKey}: ${err}`);
      }
    }
  });
}
