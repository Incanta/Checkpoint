import { db } from "./db";

export interface InstanceSummary {
  instanceId: string;
  orgCount: number;
  repoCount: number;
  userCount: number;
  lastReportedAt: Date;
}

export interface DashboardData {
  instances: InstanceSummary[];
  totals: { instances: number; orgs: number; repos: number; users: number };
  weekly: { label: string; activeInstances: number; users: number }[];
}

const WEEKS_SHOWN = 12;

function startOfWeekUTC(d: Date): Date {
  const date = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  // Shift back to Monday (getUTCDay: 0=Sun..6=Sat).
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date;
}

function weekLabel(d: Date): string {
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Latest report per instance, headline totals (summed across the latest
 * snapshot of every instance), and a 12-week trend of active instances and
 * total reported users.
 */
export async function getDashboardData(now: Date): Promise<DashboardData> {
  const reports = await db.instanceReport.findMany({
    orderBy: { reportedAt: "desc" },
    take: 10000,
  });

  const latest = new Map<string, InstanceSummary>();
  for (const r of reports) {
    if (!latest.has(r.instanceId)) {
      latest.set(r.instanceId, {
        instanceId: r.instanceId,
        orgCount: r.orgCount,
        repoCount: r.repoCount,
        userCount: r.userCount,
        lastReportedAt: r.reportedAt,
      });
    }
  }

  const instances = [...latest.values()].sort(
    (a, b) => b.lastReportedAt.getTime() - a.lastReportedAt.getTime(),
  );

  const totals = instances.reduce(
    (acc, i) => ({
      instances: acc.instances + 1,
      orgs: acc.orgs + i.orgCount,
      repos: acc.repos + i.repoCount,
      users: acc.users + i.userCount,
    }),
    { instances: 0, orgs: 0, repos: 0, users: 0 },
  );

  // Build the last WEEKS_SHOWN week buckets ending with the current week.
  const currentWeek = startOfWeekUTC(now);
  const buckets: {
    start: number;
    label: string;
    instances: Set<string>;
    latestUserByInstance: Map<string, number>;
  }[] = [];
  const indexByStart = new Map<number, number>();

  for (let i = WEEKS_SHOWN - 1; i >= 0; i--) {
    const start = new Date(currentWeek);
    start.setUTCDate(start.getUTCDate() - i * 7);
    const startMs = start.getTime();
    indexByStart.set(startMs, buckets.length);
    buckets.push({
      start: startMs,
      label: weekLabel(start),
      instances: new Set(),
      latestUserByInstance: new Map(),
    });
  }

  // reports are newest-first; the first time we see an instance in a week is
  // that week's latest snapshot for it.
  for (const r of reports) {
    const startMs = startOfWeekUTC(r.reportedAt).getTime();
    const idx = indexByStart.get(startMs);
    if (idx === undefined) continue;
    const bucket = buckets[idx]!;
    bucket.instances.add(r.instanceId);
    if (!bucket.latestUserByInstance.has(r.instanceId)) {
      bucket.latestUserByInstance.set(r.instanceId, r.userCount);
    }
  }

  const weekly = buckets.map((b) => ({
    label: b.label,
    activeInstances: b.instances.size,
    users: [...b.latestUserByInstance.values()].reduce((a, n) => a + n, 0),
  }));

  return { instances, totals, weekly };
}
