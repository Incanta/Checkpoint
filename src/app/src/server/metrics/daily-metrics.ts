import "server-only";

import { type PrismaClient } from "@prisma/client";
import { Logger } from "../logging";
import { TimeManager } from "../time";

/**
 * Build a histogram from an array of counts.
 * Returns an object mapping each distinct count to the number of orgs with that count.
 * e.g. [1, 1, 3, 3, 3, 5] → { "1": 2, "3": 3, "5": 1 }
 */
function buildHistogram(counts: number[]): Record<string, number> {
  const histogram: Record<string, number> = {};
  for (const count of counts) {
    const key = String(count);
    histogram[key] = (histogram[key] ?? 0) + 1;
  }
  return histogram;
}

/**
 * Collect all daily platform metrics and upsert a DailyMetrics row for today.
 * Should be called once per calendar day from the billing scheduler.
 */
export async function collectDailyMetrics(db: PrismaClient): Promise<void> {
  const now = TimeManager.date();
  const dateOnly = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );

  Logger.info("[Metrics] Collecting daily platform metrics");

  const [
    activeTrials,
    activeSubscriptions,
    delinquentSubs,
    totalUsers,
    activeOrgs,
    activeRepos,
    orgUserCounts,
    repoPerOrgCounts,
  ] = await Promise.all([
    // Active trials
    db.org.count({
      where: { subscriptionStatus: "TRIAL", deletedAt: null },
    }),

    // Active subscriptions
    db.org.count({
      where: { subscriptionStatus: "ACTIVE", deletedAt: null },
    }),

    // Delinquent (past due) subscriptions
    db.org.count({
      where: { subscriptionStatus: "PAST_DUE", deletedAt: null },
    }),

    // Total users
    db.user.count(),

    // Active orgs (not deleted)
    db.org.count({ where: { deletedAt: null } }),

    // Active repos (not deleted)
    db.repo.count({ where: { deletedAt: null } }),

    // OrgUsers per org (for histogram)
    db.orgUser.groupBy({
      by: ["orgId"],
      _count: { _all: true },
      where: { org: { deletedAt: null } },
    }),

    // Repos per org (for histogram)
    db.repo.groupBy({
      by: ["orgId"],
      _count: { _all: true },
      where: { deletedAt: null, org: { deletedAt: null } },
    }),
  ]);

  const orgUsersHistogram = buildHistogram(
    orgUserCounts.map((r) => r._count._all),
  );
  const reposPerOrgHistogram = buildHistogram(
    repoPerOrgCounts.map((r) => r._count._all),
  );

  await db.dailyMetrics.upsert({
    where: { date: dateOnly },
    create: {
      date: dateOnly,
      activeTrials,
      activeSubscriptions,
      delinquentSubs,
      totalUsers,
      activeOrgs,
      activeRepos,
      orgUsersHistogram,
      reposPerOrgHistogram,
    },
    update: {
      activeTrials,
      activeSubscriptions,
      delinquentSubs,
      totalUsers,
      activeOrgs,
      activeRepos,
      orgUsersHistogram,
      reposPerOrgHistogram,
    },
  });

  Logger.info(
    `[Metrics] Daily metrics collected: ` +
      `trials=${activeTrials}, subs=${activeSubscriptions}, ` +
      `delinquent=${delinquentSubs}, users=${totalUsers}, ` +
      `orgs=${activeOrgs}, repos=${activeRepos}`,
  );
}
