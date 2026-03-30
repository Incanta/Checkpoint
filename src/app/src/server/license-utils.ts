import config from "@incanta/config";

export const LICENSE_TIERS = ["BASIC", "PRO", "STUDIO", "INCANTA"] as const;
export type LicenseTier = (typeof LICENSE_TIERS)[number];

export const LicenseFeatures = [
  "pullRequests",
  "reviews",
  "shelves",
  "hordeIntegration",
  "artifacts",
  "issues",
  "dataReplicas",
  "enterpriseSaml",
] as const;

export type LicenseFeature = (typeof LicenseFeatures)[number];

// Minimum tier required for each feature
const FEATURE_MIN_TIER: Record<LicenseFeature, LicenseTier> = {
  pullRequests: "PRO",
  reviews: "PRO",
  shelves: "PRO",
  hordeIntegration: "PRO",
  artifacts: "PRO",
  issues: "PRO",
  dataReplicas: "STUDIO",
  enterpriseSaml: "STUDIO",
};

function tierIndex(tier: LicenseTier): number {
  return LICENSE_TIERS.indexOf(tier);
}

export function hasFeature(
  tier: LicenseTier,
  feature: LicenseFeature,
): boolean {
  if (tier === "INCANTA") return true;
  const required = FEATURE_MIN_TIER[feature];
  return tierIndex(tier) >= tierIndex(required);
}

export function getFeaturesForTier(tier: LicenseTier): LicenseFeature[] {
  if (tier === "INCANTA") {
    return Object.keys(FEATURE_MIN_TIER) as LicenseFeature[];
  }
  return (Object.entries(FEATURE_MIN_TIER) as [LicenseFeature, LicenseTier][])
    .filter(([, minTier]) => tierIndex(tier) >= tierIndex(minTier))
    .map(([feature]) => feature);
}

export function isLicenseManager(): boolean {
  try {
    return config.get<boolean>("licensing.is-license-manager");
  } catch {
    return false;
  }
}

export function getLicenseConfig() {
  try {
    return {
      isLicenseManager: config.get<boolean>("licensing.is-license-manager"),
      key: config.get<string>("licensing.key"),
      secret: config.get<string>("licensing.secret"),
      managerUrl: config.get<string>("licensing.manager-url"),
    };
  } catch {
    return {
      isLicenseManager: false,
      key: "",
      secret: "",
      managerUrl: "",
    };
  }
}
