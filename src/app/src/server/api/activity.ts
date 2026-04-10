import type { PrismaClient } from "@prisma/client";
import { reportOrgUserMeters } from "../billing/meter-reporting";

/**
 * Record a user activity event (read or write) for an org.
 * Uses upsert to create or increment the monthly counter.
 * Fire-and-forget — callers should not await or depend on the result.
 *
 * When a new user is recorded for the first time in a billing period,
 * triggers real-time Stripe meter reporting (debounced per-org).
 */
export async function recordActivity(
  db: PrismaClient,
  opts: {
    userId: string;
    orgId: string;
    type: "read" | "write";
  },
) {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1; // 1-12

  const isWrite = opts.type === "write";

  try {
    // Check if this user already has an activity record for this month.
    // If not, this is a new user for the period — meter counts may change.
    const existing = await db.orgUserActivity.findUnique({
      where: {
        userId_orgId_year_month: {
          userId: opts.userId,
          orgId: opts.orgId,
          year,
          month,
        },
      },
      select: { writeCount: true, readCount: true },
    });

    const isNewUser = !existing;
    // A read-only user becoming a write user changes meter counts
    const isNewWriter =
      !isNewUser &&
      isWrite &&
      existing.writeCount === 0;

    await db.orgUserActivity.upsert({
      where: {
        userId_orgId_year_month: {
          userId: opts.userId,
          orgId: opts.orgId,
          year,
          month,
        },
      },
      create: {
        userId: opts.userId,
        orgId: opts.orgId,
        year,
        month,
        writeCount: isWrite ? 1 : 0,
        readCount: isWrite ? 0 : 1,
        lastWriteAt: isWrite ? now : null,
        lastReadAt: isWrite ? null : now,
      },
      update: {
        writeCount: isWrite ? { increment: 1 } : undefined,
        readCount: isWrite ? undefined : { increment: 1 },
        lastWriteAt: isWrite ? now : undefined,
        lastReadAt: isWrite ? undefined : now,
      },
    });

    // If the user count changed, report meters to Stripe (fire-and-forget)
    if (isNewUser || isNewWriter) {
      void reportOrgUserMeters(opts.orgId, db);
    }
  } catch {
    // Activity tracking is best-effort; never block the main operation
  }
}
