import crypto from "node:crypto";
import dns from "node:dns/promises";
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
  "r2Storage",
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
  r2Storage: "STUDIO",
};

const LICENSE_MANAGER_DNS_HOST = "key.checkpointvcs.com";

let licenseManagerVerified: boolean | null = null;

/**
 * Fetches the Ed25519 public key from the DNS TXT record at key.checkpointvcs.com,
 * then verifies that the configured private key (`licensing.incanta-key`) corresponds
 * to that public key. If verification fails, the process crashes.
 */
export async function verifyLicenseManagerKey(): Promise<boolean> {
  const privateKeyBase64Source = config.tryGet<string>("licensing.incanta-key");

  if (!privateKeyBase64Source) {
    licenseManagerVerified = false;
    return false;
  }

  const privateKeyBase64 = await config.processSecrets(privateKeyBase64Source);

  if (!privateKeyBase64) {
    licenseManagerVerified = false;
    return false;
  }

  let publicKeyBase64: string;
  try {
    const records = await dns.resolveTxt(LICENSE_MANAGER_DNS_HOST);
    // TXT records come as arrays of chunks; join them
    publicKeyBase64 = records
      .map((chunks) => chunks.join(""))
      .join("")
      .trim();
  } catch (err) {
    console.error(
      `[License] Fatal: failed to resolve DNS TXT record for ${LICENSE_MANAGER_DNS_HOST}:`,
      err,
    );
    process.exit(1);
  }

  if (!publicKeyBase64) {
    console.error(
      `[License] Fatal: DNS TXT record for ${LICENSE_MANAGER_DNS_HOST} is empty`,
    );
    process.exit(1);
  }

  try {
    const privateKeyDer = Buffer.from(privateKeyBase64, "base64");
    const privateKey = crypto.createPrivateKey({
      key: privateKeyDer,
      format: "der",
      type: "pkcs8",
    });

    // Derive the public key from the configured private key
    const derivedPublicKey = crypto.createPublicKey(privateKey);
    const derivedPublicDer = derivedPublicKey.export({
      type: "spki",
      format: "der",
    });

    const expectedPublicDer = Buffer.from(publicKeyBase64, "base64");

    if (!crypto.timingSafeEqual(derivedPublicDer, expectedPublicDer)) {
      console.error(
        "[License] Fatal: configured private key does not match the public key from DNS",
      );
      process.exit(1);
    }

    licenseManagerVerified = true;
    return true;
  } catch (err) {
    console.error(
      "[License] Fatal: failed to verify license manager key:",
      err,
    );
    process.exit(1);
  }
}

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
  return licenseManagerVerified === true;
}

export function getLicenseConfig() {
  try {
    return {
      isLicenseManager: licenseManagerVerified === true,
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
