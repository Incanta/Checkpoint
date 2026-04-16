// @obfuscate

import crypto from "node:crypto";
import dns from "node:dns/promises";
import config from "@incanta/config";
import { Logger } from "./logging";

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

const LICENSE_MANAGER_KEY = Symbol.for("checkpoint.licenseManagerVerified");

const globalForLicenseManager = globalThis as unknown as {
  [LICENSE_MANAGER_KEY]?: boolean;
};

function getLicenseManagerVerified(): boolean | null {
  return globalForLicenseManager[LICENSE_MANAGER_KEY] ?? null;
}

function setLicenseManagerVerified(value: boolean) {
  globalForLicenseManager[LICENSE_MANAGER_KEY] = value;
}

/**
 * Fetches the Ed25519 public key from the DNS TXT record at key.checkpointvcs.com,
 * then verifies that the configured private key (`licensing.incanta-key`) corresponds
 * to that public key. If verification fails, the process crashes.
 */
export async function verifyLicenseManagerKey(): Promise<boolean> {
  Logger.debug("[License] Verifying license manager key...");

  const privateKeyBase64Source = config.tryGet<string>("licensing.incanta-key");

  if (!privateKeyBase64Source) {
    Logger.debug(
      "[License] No private key configured for license manager; running in non-license-manager mode",
    );
    setLicenseManagerVerified(false);
    return false;
  }

  const privateKeyBase64 = await config.processSecrets(privateKeyBase64Source);

  if (!privateKeyBase64) {
    Logger.debug(
      "[License] Failed to process private key for license manager; running in non-license-manager mode",
    );
    setLicenseManagerVerified(false);
    return false;
  }

  let publicKeyBase64: string;
  try {
    Logger.debug(
      `[License] Resolving DNS TXT record for ${LICENSE_MANAGER_DNS_HOST}...`,
    );
    const records = await dns.resolveTxt(LICENSE_MANAGER_DNS_HOST);
    // TXT records come as arrays of chunks; join them
    publicKeyBase64 = records
      .map((chunks) => chunks.join(""))
      .join("")
      .trim();
  } catch (err: any) {
    Logger.error(
      `[License] Fatal: failed to resolve DNS TXT record for ${LICENSE_MANAGER_DNS_HOST}: ${JSON.stringify(err)}`,
    );
    process.exit(1);
  }

  if (!publicKeyBase64) {
    Logger.error(
      `[License] Fatal: DNS TXT record for ${LICENSE_MANAGER_DNS_HOST} is empty`,
    );
    process.exit(1);
  }

  Logger.debug(
    `[License] Successfully retrieved public key from DNS: ${publicKeyBase64}, verifying against configured private key...`,
  );

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
      Logger.error(
        "[License] Fatal: configured private key does not match the public key from DNS",
      );
      process.exit(1);
    }

    Logger.info("[License] Successfully verified license manager key");
    setLicenseManagerVerified(true);
    return true;
  } catch (err: any) {
    Logger.error(
      `[License] Fatal: failed to verify license manager key: ${JSON.stringify(err)}`,
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
  const verified = getLicenseManagerVerified();
  Logger.debug(
    `[License] Checking if this instance is a license manager: ${verified}`,
  );
  return verified === true;
}

export function getLicenseConfig() {
  try {
    return {
      isLicenseManager: getLicenseManagerVerified() === true,
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

// ---------------------------------------------------------------------------
// JWT verification for signed license validation responses
// ---------------------------------------------------------------------------

const PUBLIC_KEY_CACHE_KEY = Symbol.for(
  "checkpoint.licenseManagerPublicKey",
);
const PUBLIC_KEY_CACHE_TIME_KEY = Symbol.for(
  "checkpoint.licenseManagerPublicKeyTime",
);

const globalForPublicKey = globalThis as unknown as {
  [PUBLIC_KEY_CACHE_KEY]?: crypto.KeyObject;
  [PUBLIC_KEY_CACHE_TIME_KEY]?: number;
};

const PUBLIC_KEY_CACHE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Resolves the license manager's Ed25519 public key from DNS and caches it.
 * Returns null if the DNS lookup fails or the record is empty.
 */
export async function resolveManagerPublicKey(): Promise<crypto.KeyObject | null> {
  const cached = globalForPublicKey[PUBLIC_KEY_CACHE_KEY];
  const cachedTime = globalForPublicKey[PUBLIC_KEY_CACHE_TIME_KEY] ?? 0;

  if (cached && Date.now() - cachedTime < PUBLIC_KEY_CACHE_MS) {
    return cached;
  }

  try {
    const records = await dns.resolveTxt(LICENSE_MANAGER_DNS_HOST);
    const publicKeyBase64 = records
      .map((chunks) => chunks.join(""))
      .join("")
      .trim();

    if (!publicKeyBase64) return null;

    const publicKeyDer = Buffer.from(publicKeyBase64, "base64");
    const publicKey = crypto.createPublicKey({
      key: publicKeyDer,
      format: "der",
      type: "spki",
    });

    globalForPublicKey[PUBLIC_KEY_CACHE_KEY] = publicKey;
    globalForPublicKey[PUBLIC_KEY_CACHE_TIME_KEY] = Date.now();

    return publicKey;
  } catch {
    return null;
  }
}

export interface ValidationTokenPayload {
  valid: boolean;
  tier: LicenseTier;
  features: LicenseFeature[];
  licenseKey: string;
}

/**
 * Verifies an EdDSA-signed JWT returned by the license manager.
 * Returns the decoded payload on success, or null if verification fails.
 */
export function verifyValidationToken(
  token: string,
  publicKey: crypto.KeyObject,
): ValidationTokenPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
    const data = `${headerB64}.${payloadB64}`;
    const signature = Buffer.from(signatureB64, "base64url");

    const isValid = crypto.verify(
      null,
      Buffer.from(data),
      publicKey,
      signature,
    );
    if (!isValid) return null;

    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString(),
    ) as ValidationTokenPayload & { exp?: number };

    if (payload.exp && Date.now() / 1000 > payload.exp) return null;

    return {
      valid: payload.valid,
      tier: payload.tier,
      features: payload.features,
      licenseKey: payload.licenseKey,
    };
  } catch {
    return null;
  }
}
