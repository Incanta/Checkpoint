import { TRPCError } from "@trpc/server";
import {
  hasFeature,
  isLicenseManager,
  type LicenseFeature,
  type LicenseTier,
} from "~/server/license-utils";
import { db } from "~/server/db";
import type { PrismaClient } from "@prisma/client";
import { Logger } from "./logging";

/**
 * Returns the license tier applied to the instance as a whole.
 *
 * Checkpoint is fully open source: every instance that is not the license
 * manager has access to all features (INCANTA tier) with no license required
 * and no user tracking. The license manager (a potential SaaS offering) also
 * runs unrestricted for itself and gates individual orgs via
 * {@link getEffectiveTier}.
 */
export function getInstanceTier(): LicenseTier {
  return "INCANTA";
}

/**
 * Initializes the license client.
 *
 * Self-hosted instances (anything that is not the license manager) no longer
 * validate against a license manager or report usage — all features are
 * enabled unconditionally. This remains a no-op so startup code has a stable
 * entry point.
 */
export async function initLicenseClient(): Promise<void> {
  if (isLicenseManager()) return;
}

/** No-op retained for API compatibility; the client no longer runs timers. */
export function stopLicenseClient(): void {
  // Nothing to tear down.
}

/**
 * Returns the effective license tier for an org, handling both licensing modes:
 *
 * - **License manager** (potential SaaS instance): each org has its own
 *   `subscriptionTier` managed via the License model. The tier is read from the
 *   org's database record so paid tiers can be enforced per org.
 *
 * - **Not the license manager** (self-hosted): every org has access to all
 *   features (INCANTA), with no license and no user tracking.
 *
 * @param orgId - The org to check
 * @param prisma - Optional PrismaClient (defaults to the global db instance)
 */
export async function getEffectiveTier(
  orgId: string,
  prisma: PrismaClient = db,
): Promise<LicenseTier> {
  if (isLicenseManager()) {
    const org = await prisma.org.findUnique({
      where: { id: orgId },
      select: { subscriptionTier: true },
    });
    return (org?.subscriptionTier ?? "BASIC") as LicenseTier;
  }
  return getInstanceTier();
}

/**
 * Asserts that the given org has access to a feature, throwing a TRPCError if
 * not. On instances that are not the license manager every feature is
 * available; on the license manager this gates on the org's subscription tier.
 *
 * @param orgId - The org to check
 * @param feature - The feature to gate on
 * @param prisma - Optional PrismaClient (defaults to the global db instance)
 * @throws TRPCError with code FORBIDDEN if the feature is not available
 */
export async function assertFeature(
  orgId: string,
  feature: LicenseFeature,
  prisma: PrismaClient = db,
): Promise<void> {
  const tier = await getEffectiveTier(orgId, prisma);
  if (!hasFeature(tier, feature)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Feature "${feature}" requires a higher license tier`,
    });
  }
}
