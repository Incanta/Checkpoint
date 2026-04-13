import type { PrismaClient } from "@prisma/client";

/**
 * Record a user activity event (read or write) for an org.
 * Uses upsert to create or increment the monthly counter.
 * Fire-and-forget — callers should not await or depend on the result.
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
  } catch {
    // Activity tracking is best-effort; never block the main operation
  }
}
