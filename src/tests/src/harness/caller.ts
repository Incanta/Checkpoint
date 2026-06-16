// In-process tRPC caller for the app's appRouter.
//
// Bypasses HTTP / Next.js entirely: we construct the tRPC ctx (db + session)
// directly and hand it to the app's `createCaller` factory. Router code runs
// exactly as it would in production, just synchronously inside the test
// process.
//
// Usage:
//
//   const alice = await makeUser(db);
//   const caller = await makeAppCaller({ asUser: alice });
//   const org = await caller.org.createOrg({ name: "Acme" });
//
// Pass `asUser: null` (or omit it) for unauthenticated tests — protected
// procedures will throw UNAUTHORIZED, public ones will run with no session.

import type { PrismaClient } from "@prisma/client";
import type { TestUser } from "./fixtures";

interface MakeCallerOpts {
  /**
   * The user the caller acts as. If omitted, ctx.session is null (matching
   * an unauthenticated request).
   */
  asUser?: TestUser | { id: string; email?: string } | null;
  /**
   * Override the PrismaClient. Defaults to the per-file test db registered
   * in `globalThis.__checkpointTestDb` by the harness setup.
   */
  db?: PrismaClient;
  /**
   * Override the Headers the ctx exposes. Most procedures don't read these;
   * a few (api-token issuing) do.
   */
  headers?: Headers;
}

function buildSession(
  user: NonNullable<MakeCallerOpts["asUser"]>,
): { user: { id: string; name?: string | null; email?: string | null; image?: string | null }; expires: string } {
  return {
    user: {
      id: user.id,
      name: "name" in user ? (user as TestUser).name ?? null : null,
      email: "email" in user ? user.email ?? null : null,
      image: null,
    },
    // Far-future — procedures don't enforce expiry on the typed session
    // (better-auth does that upstream).
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

/**
 * Build a typed caller for the appRouter. Returns the tRPC client object
 * with one method per procedure (`caller.org.createOrg(...)`,
 * `caller.repo.getRepo(...)`, etc.).
 */
export async function makeAppCaller(opts: MakeCallerOpts = {}) {
  const db =
    opts.db ??
    (globalThis.__checkpointTestDb as PrismaClient | undefined);
  if (!db) {
    throw new Error(
      "No PrismaClient available — call createTestDb() in beforeAll first.",
    );
  }

  const { createCaller } = await import("~/server/api/root");

  const ctx = {
    db,
    session: opts.asUser ? buildSession(opts.asUser) : null,
    headers: opts.headers ?? new Headers(),
  };

  return createCaller(ctx);
}

/** Shortcut for a caller that has no session (anonymous). */
export function makeAnonCaller(opts: Omit<MakeCallerOpts, "asUser"> = {}) {
  return makeAppCaller({ ...opts, asUser: null });
}
