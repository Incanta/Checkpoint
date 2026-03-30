import { getLicenseConfig, isLicenseManager, type LicenseTier } from "~/server/license-utils";
import { db } from "~/server/db";

let cachedTier: LicenseTier = "BASIC";
let lastValidation = 0;
let validationTimer: ReturnType<typeof setInterval> | null = null;

const VALIDATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const REPORTING_DAY = 2; // 2nd day of month

export function getInstanceTier(): LicenseTier {
  if (isLicenseManager()) {
    // License manager always returns INCANTA for itself (unrestricted)
    return "INCANTA";
  }
  return cachedTier;
}

async function validateWithManager(): Promise<LicenseTier> {
  const config = getLicenseConfig();
  if (!config.key || !config.secret || !config.managerUrl) {
    return "BASIC";
  }

  try {
    const response = await fetch(`${config.managerUrl}/api/license/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: config.key, secret: config.secret }),
    });

    if (!response.ok) {
      console.warn(`[License] Validation failed: ${response.status}`);
      return cachedTier; // Keep cached tier on failure
    }

    const data = (await response.json()) as { valid: boolean; tier: LicenseTier };
    if (!data.valid) {
      console.warn("[License] License is not valid");
      return "BASIC";
    }

    return data.tier;
  } catch (error) {
    console.warn("[License] Failed to reach license manager:", error);
    return cachedTier; // Keep cached tier on network failure
  }
}

async function reportUsage(): Promise<void> {
  const config = getLicenseConfig();
  if (!config.key || !config.secret || !config.managerUrl) return;

  const now = new Date();
  // Report for the previous month
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth(); // 0-11, so this is previous month (getUTCMonth() + 1 - 1)
  if (month === 0) {
    month = 12;
    year -= 1;
  }

  try {
    // Count distinct active write users and active read users across all orgs
    const activities = await db.orgUserActivity.findMany({
      where: { year, month },
      select: { userId: true, writeCount: true, readCount: true },
    });

    const writeUsers = new Set<string>();
    const readUsers = new Set<string>();
    for (const a of activities) {
      if (a.writeCount > 0) writeUsers.add(a.userId);
      if (a.readCount > 0) readUsers.add(a.userId);
    }

    await fetch(`${config.managerUrl}/api/license/report-usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: config.key,
        secret: config.secret,
        year,
        month,
        awuCount: writeUsers.size,
        aruCount: readUsers.size,
      }),
    });
  } catch (error) {
    console.warn("[License] Failed to report usage:", error);
  }
}

export async function initLicenseClient(): Promise<void> {
  if (isLicenseManager()) return;

  // Validate on startup
  cachedTier = await validateWithManager();
  lastValidation = Date.now();
  console.log(`[License] Validated. Tier: ${cachedTier}`);

  // Periodic re-validation
  validationTimer = setInterval(() => {
    void (async () => {
      cachedTier = await validateWithManager();
      lastValidation = Date.now();
      console.log(`[License] Re-validated. Tier: ${cachedTier}`);

      // Report usage on the reporting day
      const now = new Date();
      if (now.getUTCDate() === REPORTING_DAY) {
        await reportUsage();
      }
    })();
  }, VALIDATION_INTERVAL_MS);
}

export function stopLicenseClient(): void {
  if (validationTimer) {
    clearInterval(validationTimer);
    validationTimer = null;
  }
}
