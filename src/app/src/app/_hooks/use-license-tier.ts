"use client";

import { api } from "~/trpc/react";

export type LicenseFeature =
  | "pullRequests"
  | "reviews"
  | "shelves"
  | "hordeIntegration"
  | "artifacts"
  | "dataReplicas"
  | "enterpriseSaml";

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
