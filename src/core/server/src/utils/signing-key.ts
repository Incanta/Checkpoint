import config from "@incanta/config";

// The storage signing key is the whole of storage security: the app signs
// repo-scoped tokens with it and this server trusts any token that verifies.
// Whoever knows the key can mint a write token for any repo. It used to
// default to "secret", so an instance that never set it was open to anyone
// who had read the source.
//
// There is no default now. A key must be configured, and one that is short or
// a known placeholder is refused, at startup and again on every use.
//
// Set it with the CHECKPOINT_STORAGE_SIGNING_KEY environment variable or the
// storage.jwt.signing-key config value, to the same value on the app and on
// this server. `openssl rand -hex 32` makes a good one.
//
// Mirrored in src/app/src/server/storage-signing-key.ts (the app does not
// depend on this package). Keep the two in step.

export const SIGNING_KEY_ENV = "CHECKPOINT_STORAGE_SIGNING_KEY";

// HS256 keys shorter than the hash output add nothing but weakness.
const MIN_LENGTH = 32;

const PLACEHOLDERS = new Set([
  "secret",
  "changeme",
  "change-me",
  "password",
  "test-jwt-secret",
]);

/** Why `key` cannot be used, or null if it is acceptable. */
export function signingKeyProblem(key: unknown): string | null {
  if (typeof key !== "string" || key.length === 0) {
    return "no storage signing key is configured";
  }
  if (PLACEHOLDERS.has(key.toLowerCase())) {
    return "the storage signing key is a well-known placeholder";
  }
  if (key.length < MIN_LENGTH) {
    return `the storage signing key is too short (${key.length} characters, need at least ${MIN_LENGTH})`;
  }
  if (new Set(key).size < 8) {
    return "the storage signing key has almost no variety in it";
  }
  return null;
}

// storage.jwt.signing-key may be a secret reference ("secret|<name>"). Tokens
// are verified synchronously on every request, so the reference is resolved
// once, by loadStorageSigningKey() at startup, and the value kept here.
let resolvedConfigKey: { value: unknown } | null = null;

function isSecretReference(value: unknown): boolean {
  return typeof value === "string" && value.includes("secret|");
}

function configuredKey(): unknown {
  const fromEnv = process.env[SIGNING_KEY_ENV];
  if (fromEnv) {
    return fromEnv;
  }
  if (resolvedConfigKey) {
    return resolvedConfigKey.value;
  }
  const key = config.get<string>("storage.jwt.signing-key");
  if (isSecretReference(key)) {
    // Never sign or verify with the reference text itself.
    throw new Error(
      "Refusing to use storage tokens: storage.jwt.signing-key is a secret reference that has not been resolved (call loadStorageSigningKey() at startup)",
    );
  }
  return key;
}

/**
 * Resolves storage.jwt.signing-key through the secrets provider, keeps the
 * result for storageSigningKey(), and checks it. Throws if it is unusable.
 */
export async function loadStorageSigningKey(): Promise<string> {
  const key = config.get<string>("storage.jwt.signing-key");
  resolvedConfigKey = {
    value: isSecretReference(key)
      ? await config.processSecrets<string>(key)
      : key,
  };
  return storageSigningKey();
}

/** Forgets the key loadStorageSigningKey() resolved (for tests). */
export function forgetLoadedStorageSigningKey(): void {
  resolvedConfigKey = null;
}

export const SIGNING_KEY_HELP =
  `Set ${SIGNING_KEY_ENV} (or storage.jwt.signing-key) to a random value of at least ${MIN_LENGTH} characters, ` +
  `the same on the app and the core server. For example: openssl rand -hex 32`;

/** The key to sign and verify storage tokens with. Throws if it is unusable. */
export function storageSigningKey(): string {
  const key = configuredKey();
  const problem = signingKeyProblem(key);
  if (problem) {
    throw new Error(
      `Refusing to use storage tokens: ${problem}. ${SIGNING_KEY_HELP}`,
    );
  }
  return key as string;
}
