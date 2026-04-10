import "server-only";

import Stripe from "stripe";
import config from "@incanta/config";
import { isLicenseManager } from "../license-utils";
import { Logger } from "../logging";

const STRIPE_CLIENT_KEY = Symbol.for("checkpoint.stripe.client");

const globalForStripe = globalThis as unknown as {
  [STRIPE_CLIENT_KEY]?: Stripe | null;
};

export function isStripeEnabled(): boolean {
  try {
    return (
      isLicenseManager() && config.tryGet<boolean>("stripe.enabled") === true
    );
  } catch {
    return false;
  }
}

export function getStripeClient(): Stripe {
  const cached = globalForStripe[STRIPE_CLIENT_KEY];
  if (cached) return cached;

  if (!isStripeEnabled()) {
    throw new Error("Stripe is not enabled");
  }

  const secretKey = config.get<string>("stripe.secret-key");
  if (!secretKey) {
    throw new Error("Stripe secret key is not configured");
  }

  const apiVersionOverride =
    config.tryGet<string>("stripe.api-version") || undefined;

  // When no override is configured, omit apiVersion so the SDK uses its
  // built-in latest (2026-03-25.dahlia). Override only for pinning or preview.
  const client = apiVersionOverride
    ? // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      new Stripe(secretKey, { apiVersion: apiVersionOverride as any })
    : new Stripe(secretKey);

  globalForStripe[STRIPE_CLIENT_KEY] = client;

  const env = config.get<string>("stripe.environment") || "sandbox";
  Logger.info(`[Stripe] Client initialized (${env})`);
  return client;
}

export function getStripePublishableKey(): string {
  return config.get<string>("stripe.publishable-key") || "";
}

export function getStripeWebhookSecret(): string {
  return config.get<string>("stripe.webhook-secret") || "";
}

export function getStripeEnvironment(): string {
  try {
    return config.get<string>("stripe.environment") || "sandbox";
  } catch {
    return "sandbox";
  }
}

export interface StripePriceConfig {
  cloud: {
    "studio-write": string;
    "studio-read": string;
    "pro-write": string;
    "pro-read": string;
    "basic-write": string;
    "basic-read": string;
    storage: string;
    "minimum-due": string;
  };
  selfHosted: {
    "studio-write": string;
    "studio-read": string;
    "pro-write": string;
    "pro-read": string;
  };
}

export function getStripePriceConfig(): StripePriceConfig {
  return {
    cloud: {
      "studio-write": config.get<string>("stripe.prices.cloud.studio-write"),
      "studio-read": config.get<string>("stripe.prices.cloud.studio-read"),
      "pro-write": config.get<string>("stripe.prices.cloud.pro-write"),
      "pro-read": config.get<string>("stripe.prices.cloud.pro-read"),
      "basic-write": config.get<string>("stripe.prices.cloud.basic-write"),
      "basic-read": config.get<string>("stripe.prices.cloud.basic-read"),
      storage: config.get<string>("stripe.prices.cloud.storage"),
      "minimum-due": config.get<string>("stripe.prices.cloud.minimum-due"),
    },
    selfHosted: {
      "studio-write": config.get<string>(
        "stripe.prices.self-hosted.studio-write",
      ),
      "studio-read": config.get<string>(
        "stripe.prices.self-hosted.studio-read",
      ),
      "pro-write": config.get<string>("stripe.prices.self-hosted.pro-write"),
      "pro-read": config.get<string>("stripe.prices.self-hosted.pro-read"),
    },
  };
}

export function getMeterNames() {
  return {
    writeUsers:
      config.get<string>("stripe.meters.write-users") ||
      "checkpoint_write_users",
    readUsers:
      config.get<string>("stripe.meters.read-users") || "checkpoint_read_users",
    storageBuckets:
      config.get<string>("stripe.meters.storage-buckets") ||
      "checkpoint_storage_buckets",
    minimumDue:
      config.get<string>("stripe.meters.minimum-due") ||
      "checkpoint_minimum_due",
  };
}

export function getStoragePricingConfig() {
  return {
    freeTierGb: config.get<number>("stripe.storage.free-tier-gb"),
    bucketSizeGb: config.get<number>("stripe.storage.bucket-size-gb"),
    bucketPriceCents: config.get<number>("stripe.storage.bucket-price-cents"),
  };
}

export function getMinimumInvoiceCents(): number {
  return config.get<number>("stripe.minimum-invoice-cents") || 500;
}

export function getDelinquencyConfig() {
  return {
    suspendAfterDays: config.get<number>(
      "stripe.delinquency.suspend-after-days",
    ),
    deleteAfterDays: config.get<number>("stripe.delinquency.delete-after-days"),
  };
}

export function getTrialDurationDays(): number {
  return config.get<number>("stripe.trial.duration-days") || 30;
}

export function getCardExpiryNotifyDays(): number[] {
  return config.get<number[]>("stripe.card-expiry-notify-days") || [30, 7];
}

/** Seat price ID for a given tier and activity type (cloud product). */
export function getSeatPriceId(
  tier: string,
  activity: "read" | "write",
): string | null {
  const prices = getStripePriceConfig().cloud;
  const key = `${tier.toLowerCase()}-${activity}` as keyof typeof prices;
  return prices[key] || null;
}

/** Reset cached client (for testing or config reload). */
export function resetStripeClient(): void {
  globalForStripe[STRIPE_CLIENT_KEY] = null;
}
