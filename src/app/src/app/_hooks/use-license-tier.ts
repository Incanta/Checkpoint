"use client";

import type { LicenseFeature } from "~/server/license-utils";
import { api } from "~/trpc/react";

export function useLicenseTier(orgId: string | undefined) {
  const { data, isLoading } = api.license.getEffectiveTier.useQuery(
    { orgId: orgId ?? "" },
    { enabled: !!orgId, staleTime: 5 * 60 * 1000 },
  );

  return {
    tier: data?.tier ?? "BASIC",
    features: data?.features ?? [],
    isLoading,
    hasFeature: (feature: LicenseFeature) =>
      data?.features?.includes(feature) ?? false,
  };
}
