import "server-only";

import type { PrismaClient } from "@prisma/client";
import config from "@incanta/config";
import { Logger } from "../logging";
import { getStoragePricingConfig } from "../stripe/client";

export interface StorageChargeResult {
  totalBytes: number;
  totalGB: number;
  buckets: number;
  chargeCents: number;
}

/**
 * Calculate the storage charge for an org based on total repo sizes.
 * Charge = Math.ceil((totalGB - freeTierGB) / bucketSizeGB) * bucketPriceCents
 * Returns 0 if total usage is within the free tier.
 */
export async function calculateStorageCharge(
  orgId: string,
  db: PrismaClient,
): Promise<StorageChargeResult> {
  const repos = await db.repo.findMany({
    where: { orgId, deletedAt: null },
    select: { id: true, orgId: true },
  });

  if (repos.length === 0) {
    return { totalBytes: 0, totalGB: 0, buckets: 0, chargeCents: 0 };
  }

  // Fetch sizes from the storage backend for each repo
  let totalBytes = 0;
  const backendUrl = config.get<string>("storage.backend-url.internal");
  const systemKey = config.get<string>("storage.signing-keys.system");

  for (const repo of repos) {
    try {
      const jwt = await createSystemJwt(orgId, repo.id, systemKey);
      const res = await fetch(`${backendUrl}/repo-size`, {
        headers: {
          Authorization: `Bearer ${jwt}`,
          "X-Org-Id": orgId,
          "X-Repo-Id": repo.id,
        },
      });
      if (res.ok) {
        const data = (await res.json()) as { size?: number };
        totalBytes += data.size ?? 0;
      }
    } catch (err: any) {
      Logger.warn(
        `[Billing] Failed to fetch size for repo ${repo.id}: ${JSON.stringify(err)}`,
      );
    }
  }

  const { freeTierGb, bucketSizeGb, bucketPriceCents } =
    getStoragePricingConfig();

  const totalGB = totalBytes / (1024 * 1024 * 1024);
  const chargeableGB = totalGB - freeTierGb;

  if (chargeableGB <= 0) {
    return { totalBytes, totalGB, buckets: 0, chargeCents: 0 };
  }

  const buckets = Math.ceil(chargeableGB / bucketSizeGb);
  const chargeCents = buckets * bucketPriceCents;

  return { totalBytes, totalGB, buckets, chargeCents };
}

/** Create a minimal system JWT for internal storage API calls. */
async function createSystemJwt(
  orgId: string,
  repoId: string,
  systemKey: string,
): Promise<string> {
  // Use the same JWT signing approach as the storage router
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
