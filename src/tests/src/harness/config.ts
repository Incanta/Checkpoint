// In-memory test config that mocks `@incanta/config` for fast in-process
// tests. The vitest-setup file replaces `import config from "@incanta/config"`
// with an object that proxies to `testConfig` here. Tests can mutate it via
// `setConfig(key, value)` and reset via `resetConfig()` (called in the
// global beforeEach).
//
// Defaults represent the most common path through the app on the `main`
// branch — SeaweedFS storage, sqlite, dev login enabled. Tests that need a
// different shape override individual keys.

type ConfigValue =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | Record<string, unknown>
  | null;

const testConfig: Map<string, ConfigValue> = new Map();

export function setConfig(key: string, value: ConfigValue): void {
  testConfig.set(key, value);
}

export function setConfigMany(values: Record<string, ConfigValue>): void {
  for (const [k, v] of Object.entries(values)) {
    testConfig.set(k, v);
  }
}

export function resetConfig(): void {
  testConfig.clear();
  applyDefaults();
}

function applyDefaults(): void {
  // Server / env
  setConfig("server.listen-port", 13000);
  setConfig("server.external-url", "https://app.test.local");

  // Auth — enable dev login by default so router tests can mint tokens.
  setConfig("auth.dev.allow-dev-login", true);
  setConfig("auth.secret", "test-better-auth-secret-min-32-chars-long");
  setConfig("auth.email-password.enabled", true);
  setConfig("auth.discord.enabled", false);
  setConfig("auth.github.enabled", false);
  setConfig("auth.gitlab.enabled", false);
  setConfig("auth.okta.enabled", false);
  setConfig("auth.auth0.enabled", false);

  // Database
  setConfig("db.provider", "sqlite");
  setConfig("db.url", "file:./test.db");

  // Storage — SeaweedFS via the local server
  setConfig("storage.mode", "seaweedfs");
  setConfig("storage.backend-url.internal", "http://localhost:13001");
  setConfig("storage.backend-url.external", "http://localhost:13001");
  setConfig("storage.jwt.signing-key", "test-jwt-secret");
  setConfig("storage.token-expiration-seconds", 3600);

  // Logging — silence by default
  setConfig("logging.level", "error");

  // Email — disabled
  setConfig("email.enabled", false);
  setConfig("email.from.name", "Test");
  setConfig("email.from.address", "noreply@test.local");

  // ─────────────────────────────────────────────────────────────────
  // Premium-only defaults. Harmless on main (those modules don't read
  // these keys); required on premium so isStripeEnabled() / billing /
  // license code don't blow up on missing config.
  // ─────────────────────────────────────────────────────────────────

  setConfig("stripe.enabled", true);
  setConfig("stripe.secret-key", "sk_test_dummy");
  setConfig("stripe.publishable-key", "pk_test_dummy");
  setConfig("stripe.webhook-secret", "whsec_test_dummy_secret");
  setConfig("stripe.api-version", "");
  setConfig("stripe.environment", "sandbox");
  setConfig("stripe.trial.duration-days", 30);
  setConfig("stripe.delinquency.suspend-after-days", 5);
  setConfig("stripe.delinquency.delete-after-days", 14);
  setConfig("stripe.minimum-invoice.enabled", false);
  setConfig("stripe.minimum-invoice.cents", 500);
  setConfig("stripe.storage.free-tier-gb", 0);
  setConfig("stripe.storage.bucket-size-gb", 50);
  setConfig("stripe.storage.bucket-price-cents", 250);
  setConfig("stripe.card-expiry-notify-days", [30, 7]);

  // Meters
  setConfig("stripe.meters.write-users", "checkpoint_write_users");
  setConfig("stripe.meters.read-users", "checkpoint_read_users");
  setConfig("stripe.meters.storage-buckets", "checkpoint_storage_buckets");
  setConfig("stripe.meters.minimum-due", "checkpoint_minimum_due");

  // Prices (cloud)
  setConfig("stripe.prices.cloud.studio-write", "price_cloud_studio_write");
  setConfig("stripe.prices.cloud.studio-read", "price_cloud_studio_read");
  setConfig("stripe.prices.cloud.pro-write", "price_cloud_pro_write");
  setConfig("stripe.prices.cloud.pro-read", "price_cloud_pro_read");
  setConfig("stripe.prices.cloud.basic-write", "price_cloud_basic_write");
  setConfig("stripe.prices.cloud.basic-read", "price_cloud_basic_read");
  setConfig("stripe.prices.cloud.storage", "price_cloud_storage");
  setConfig("stripe.prices.cloud.minimum-due", "price_cloud_minimum_due");

  // Prices (self-hosted)
  setConfig("stripe.prices.self-hosted.studio-write", "price_sh_studio_write");
  setConfig("stripe.prices.self-hosted.studio-read", "price_sh_studio_read");
  setConfig("stripe.prices.self-hosted.pro-write", "price_sh_pro_write");
  setConfig("stripe.prices.self-hosted.pro-read", "price_sh_pro_read");

  // Seat pricing — meter-reporting reads this as a single nested object.
  setConfig("stripe.seat-prices", {
    cloud: {
      basic: { write: 400, read: 200 },
      pro: { write: 900, read: 400 },
      studio: { write: 2400, read: 1200 },
    },
    selfHosted: {
      basic: { write: 0, read: 0 },
      pro: { write: 400, read: 200 },
      studio: { write: 900, read: 400 },
    },
  });
}

// Apply defaults at module load so any test that imports the harness without
// calling resetConfig() still gets sensible values.
applyDefaults();

/** Object the vitest-setup wires in as the @incanta/config default export. */
export const testConfigShim = {
  get<T>(key: string): T {
    if (!testConfig.has(key)) {
      throw new Error(`Test config missing required key: ${key}`);
    }
    return testConfig.get(key) as T;
  },
  tryGet<T>(key: string): T | undefined {
    return testConfig.has(key) ? (testConfig.get(key) as T) : undefined;
  },
  async getWithSecrets<T>(key: string): Promise<T> {
    return this.get<T>(key);
  },
  async processSecrets(value: string): Promise<string> {
    return value;
  },
};
