import "server-only";

import type { PrismaClient } from "@prisma/client";
import config from "@incanta/config";
import { Logger } from "~/server/logging";
import { TimeManager } from "~/server/time";
import { isLicenseManager } from "~/server/license-utils";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Send an anonymous usage report (org/repo/user counts plus this instance's
 * random instanceId) to the Incanta-hosted metrics server, at most once a
 * week.
 *
 * This is strictly fire-and-forget: any failure (network, opt-out, missing
 * config) is swallowed so it can never affect the running app. The cloud
 * license-manager instance is the telemetry sink, not a reporter, so it skips
 * itself.
 */
export async function reportTelemetryIfDue(
  db: PrismaClient,
  opts: { force?: boolean } = {},
): Promise<void> {
  try {
    if (isLicenseManager()) return;

    const enabled = config.tryGet<boolean>("telemetry.enabled") ?? true;
    if (!enabled) return;

    const settings = await db.instanceSettings.findUnique({
      where: { id: "default" },
    });

    // Not configured yet (setup not completed), or the operator opted out.
    if (!settings?.instanceId) return;
    if (!settings.telemetryEnabled) return;

    if (!opts.force && settings.lastTelemetryAt) {
      const elapsed = TimeManager.now() - settings.lastTelemetryAt.getTime();
      if (elapsed < WEEK_MS) return;
    }

    const [orgCount, repoCount, userCount] = await Promise.all([
      db.org.count({ where: { deletedAt: null } }),
      db.repo.count({ where: { deletedAt: null } }),
      db.user.count(),
    ]);

    const endpoint = config
      .get<string>("telemetry.endpoint-url")
      .replace(/\/+$/, "");

    const res = await fetch(`${endpoint}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instanceId: settings.instanceId,
        orgCount,
        repoCount,
        userCount,
      }),
    });

    if (!res.ok) {
      Logger.warn(`[Telemetry] Report failed: HTTP ${res.status}`);
      return;
    }

    await db.instanceSettings.update({
      where: { id: "default" },
      data: { lastTelemetryAt: TimeManager.date() },
    });

    Logger.debug(
      `[Telemetry] Reported usage (orgs=${orgCount}, repos=${repoCount}, users=${userCount})`,
    );
  } catch (err: unknown) {
    // Never throw from telemetry.
    Logger.debug(`[Telemetry] Report skipped due to error: ${String(err)}`);
  }
}
