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
