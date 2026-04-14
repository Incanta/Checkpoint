import "server-only";

import type { PrismaClient } from "@prisma/client";
import config from "@incanta/config";
import { Logger } from "../logging";
import { TimeManager } from "../time";
import { getStoragePricingConfig } from "../stripe/client";
import { isLicenseManager } from "../license-utils";
import { getBucketUsageR2, isR2Enabled } from "../r2-service";
import { getBillingPeriod } from "./billing-period";

export interface StorageChargeResult {
  totalBytes: number;
  totalGB: number;
  peakBytes: bigint;
  buckets: number;
  chargeCents: number;
}

/**
 * Calculate the storage charge for an org based on total repo sizes.
 * Uses max(current live storage, peak recorded this period) for billing.
 * Charge = Math.ceil((effectiveGB - freeTierGB) / bucketSizeGB) * bucketPriceCents
 * Returns 0 if total usage is within the free tier.
 */
export async function calculateStorageCharge(
  orgId: string,
  db: PrismaClient,
): Promise<StorageChargeResult> {
  const repos = await db.repo.findMany({
    where: { orgId, deletedAt: null },
    select: { id: true, orgId: true, r2BucketName: true },
  });

  // Fetch sizes from the storage backend for each live repo
  let totalBytes = 0;
  const backendUrl = config.get<string>("storage.backend-url.internal");
  const systemKey = config.get<string>("storage.jwt.signing-key");

  for (const repo of repos) {
    try {
      if (isR2Enabled()) {
        if (!repo.r2BucketName) {
          Logger.warn(
            `[Billing] Repo ${repo.id} is missing R2 bucket name, skipping usage calculation`,
          );
          continue;
        }

        const usage = await getBucketUsageR2(repo.r2BucketName);
        totalBytes += Number(usage);
      } else {
        const jwt = await createSystemJwt(orgId, repo.id, systemKey);
        const res = await fetch(`${backendUrl}/repo-size`, {
          headers: {
            Authorization: `Bearer ${jwt}`,
          },
        });
        if (res.ok) {
          const data = (await res.json()) as { size?: number };
          totalBytes += data.size ?? 0;
        } else {
          Logger.warn(
            `[Billing] Failed to fetch size for repo ${repo.id}: ${res.status} ${res.statusText}`,
          );
        }
      }
    } catch (err: unknown) {
      Logger.warn(
        `[Billing] Failed to fetch size for repo ${repo.id}: ${String(err)}`,
      );
    }
  }

  // Peak tracking is only relevant on the license manager (billing instance).
  // Non-license-manager instances just report current live usage.
  let peakBytes = BigInt(totalBytes);

  if (isLicenseManager()) {
    const org = await db.org.findUnique({
      where: { id: orgId },
      select: { billingCycleAnchor: true },
    });
    const { year, month } = getBillingPeriod(
      TimeManager.date(),
      org?.billingCycleAnchor ?? 1,
    );

    const peak = await db.orgStoragePeak.upsert({
      where: { orgId_year_month: { orgId, year, month } },
      create: { orgId, year, month, peakStorageBytes: BigInt(totalBytes) },
      update: {},
    });

    peakBytes = peak.peakStorageBytes;
    if (BigInt(totalBytes) > peakBytes) {
      peakBytes = BigInt(totalBytes);
      await db.orgStoragePeak.update({
        where: { orgId_year_month: { orgId, year, month } },
        data: { peakStorageBytes: peakBytes },
      });
    }
  }

  // Use max(current, peak) for billing (on non-LM instances, peak === current)
  const effectiveBytes =
    BigInt(totalBytes) > peakBytes ? BigInt(totalBytes) : peakBytes;
  const { freeTierGb, bucketSizeGb, bucketPriceCents } =
    getStoragePricingConfig();

  const effectiveGB = Number(effectiveBytes) / (1024 * 1024 * 1024);
  const totalGB = totalBytes / (1024 * 1024 * 1024);
  const chargeableGB = effectiveGB - freeTierGb;

  if (chargeableGB <= 0) {
    return { totalBytes, totalGB, peakBytes, buckets: 0, chargeCents: 0 };
  }

  const buckets = Math.ceil(chargeableGB / bucketSizeGb);
  const chargeCents = buckets * bucketPriceCents;

  return { totalBytes, totalGB, peakBytes, buckets, chargeCents };
}

/**
 * Snapshot the current org storage total as a peak value.
 * Called during repo deletion to ensure the peak is recorded before
 * storage is cleaned up. Only runs on the license manager instance.
 */
export async function snapshotStoragePeak(
  orgId: string,
  db: PrismaClient,
): Promise<void> {
  if (!isLicenseManager()) return;
  await calculateStorageCharge(orgId, db);
}

/** Create a minimal system JWT for internal storage API calls. */
async function createSystemJwt(
  orgId: string,
  repoId: string,
  systemKey: string,
): Promise<string> {
  const { SignJWT } = await import("jose");
  const secret = new TextEncoder().encode(systemKey);
  return await new SignJWT({
    orgId,
    repoId,
    access: "read",
    type: "system",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("5m")
    .sign(secret);
}
