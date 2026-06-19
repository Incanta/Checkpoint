import crypto from "node:crypto";
import dns from "node:dns/promises";
import config from "@incanta/config";
import { Logger } from "./logging.js";

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
const TOKEN_EXPIRY_SECONDS = 48 * 60 * 60; // 48 hours

let signingKey: crypto.KeyObject | null = null;

export function getSigningKey(): crypto.KeyObject {
  if (!signingKey) {
    throw new Error(
      "Signing key not initialized. Was verifyLicenseManagerKey() called?",
    );
  }
  return signingKey;
}

/**
 * Signs a license validation response as an EdDSA JWT.
 * The token can be verified by clients using the public key from DNS.
 */
export function signValidationToken(payload: {
  tier: LicenseTier;
  features: LicenseFeature[];
  licenseKey: string;
}): string {
  const key = getSigningKey();
  const now = Math.floor(Date.now() / 1000);

  const header = JSON.stringify({ alg: "EdDSA", typ: "JWT" });
  const body = JSON.stringify({
    ...payload,
    valid: true,
    iat: now,
    exp: now + TOKEN_EXPIRY_SECONDS,
  });

  const headerB64 = Buffer.from(header).toString("base64url");
  const payloadB64 = Buffer.from(body).toString("base64url");
  const data = `${headerB64}.${payloadB64}`;
  const signature = crypto.sign(null, Buffer.from(data), key);
  return `${data}.${signature.toString("base64url")}`;
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

/**
 * Fetches the Ed25519 public key from the DNS TXT record at key.checkpointvcs.com,
 * then verifies that the configured private key (`licensing.incanta-key`) corresponds
 * to that public key. Returns false if verification fails.
 */
export async function verifyLicenseManagerKey(): Promise<boolean> {
  Logger.info("Verifying license manager key...");

  const privateKeyBase64Source = config.tryGet<string>("licensing.incanta-key");

  if (!privateKeyBase64Source) {
    Logger.error(
      "No private key configured (licensing.incanta-key). Cannot run as license manager.",
    );
    return false;
  }

  const privateKeyBase64 = await config.processSecrets(privateKeyBase64Source);

  if (!privateKeyBase64) {
    Logger.error("Failed to process private key secret");
    return false;
  }

  let publicKeyBase64: string;
  try {
    Logger.debug(`Resolving DNS TXT record for ${LICENSE_MANAGER_DNS_HOST}...`);
    const records = await dns.resolveTxt(LICENSE_MANAGER_DNS_HOST);
    publicKeyBase64 = records
      .map((chunks) => chunks.join(""))
      .join("")
      .trim();
  } catch (err) {
    Logger.fatal(
      { err },
      `Failed to resolve DNS TXT record for ${LICENSE_MANAGER_DNS_HOST}`,
    );
    return false;
  }

  if (!publicKeyBase64) {
    Logger.fatal(`DNS TXT record for ${LICENSE_MANAGER_DNS_HOST} is empty`);
    return false;
  }

  try {
    const privateKeyDer = Buffer.from(privateKeyBase64, "base64");
    const privateKey = crypto.createPrivateKey({
      key: privateKeyDer,
      format: "der",
      type: "pkcs8",
    });

    const derivedPublicKey = crypto.createPublicKey(privateKey);
    const derivedPublicDer = derivedPublicKey.export({
      type: "spki",
      format: "der",
    });

    const expectedPublicDer = Buffer.from(publicKeyBase64, "base64");

    if (!crypto.timingSafeEqual(derivedPublicDer, expectedPublicDer)) {
      Logger.fatal(
        "Configured private key does not match the public key from DNS",
      );
      return false;
    }

    signingKey = privateKey;
    Logger.info("Successfully verified license manager key");
    return true;
  } catch (err) {
    Logger.fatal({ err }, "Failed to verify license manager key");
    return false;
  }
}
