import type { PrismaClient } from "@prisma/client";
import { getBillingPeriod } from "../billing/billing-period";
import { TimeManager } from "../time";
import { isLicenseManager } from "~/server/license-utils";

/**
 * Record a user activity event (read or write) for an org.
 * Uses upsert to create or increment the monthly counter.
 * Fire-and-forget — callers should not await or depend on the result.
 *
 * Only the license manager (a potential SaaS offering) tracks per-user
 * activity, since it bills orgs by active users. Instances that are not the
 * license manager do no user tracking.
 */
export async function recordActivity(
  db: PrismaClient,
  opts: {
    userId: string;
    orgId: string;
    type: "read" | "write";
  },
) {
  if (!isLicenseManager()) return;

  const now = TimeManager.date();
  const isWrite = opts.type === "write";

  try {
    const org = await db.org.findUnique({
      where: { id: opts.orgId },
      select: { billingCycleAnchor: true },
    });
    const { year, month } = getBillingPeriod(now, org?.billingCycleAnchor ?? 1);

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
