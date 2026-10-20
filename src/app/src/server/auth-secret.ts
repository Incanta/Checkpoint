import config from "@incanta/config";

// The auth secret signs every session cookie, so whoever knows it can sign in
// as anyone. It also keys stored integration secrets (issue tracker tokens)
// when security.encryption-key is not set. It used to default to a value
// printed in the public config, so an instance that never set it accepted
// sessions anyone could forge.
//
// There is no default now. A secret must be configured, and one that is
// short or a known placeholder is refused, as for the storage signing key
// (storage-signing-key.ts).
//
// Set it with the CHECKPOINT_AUTH_SECRET environment variable or the
// auth.secret config value (which may be a secret reference, such as
// "secret|betterauth_secret"). `openssl rand -hex 32` makes a good one.

export const AUTH_SECRET_ENV = "CHECKPOINT_AUTH_SECRET";

const MIN_LENGTH = 32;

const PLACEHOLDERS = new Set([
  "secret",
  "changeme",
  "change-me",
  "password",
  // The default this config used to ship, and the Docker Compose template's.
  "betterauthsecretthatsatleast32characterslong",
  "changeme-betterauth-secret",
]);

/** Why `secret` cannot be used, or null if it is acceptable. */
export function authSecretProblem(secret: unknown): string | null {
  if (typeof secret !== "string" || secret.length === 0) {
    return "no auth secret is configured";
  }
  if (PLACEHOLDERS.has(secret.toLowerCase())) {
    return "the auth secret is a well-known placeholder";
  }
  if (secret.length < MIN_LENGTH) {
    return `the auth secret is too short (${secret.length} characters, need at least ${MIN_LENGTH})`;
  }
  if (new Set(secret).size < 8) {
    return "the auth secret has almost no variety in it";
  }
  return null;
}

export const AUTH_SECRET_HELP = `Set ${AUTH_SECRET_ENV} (or auth.secret) to a random value of at least ${MIN_LENGTH} characters. For example: openssl rand -hex 32`;

/** The secret sessions are signed with. Throws if it is unusable. */
export async function authSecret(): Promise<string> {
  const secret =
    process.env[AUTH_SECRET_ENV] ||
    (await config.getWithSecrets<string>("auth.secret"));
  const problem = authSecretProblem(secret);
  if (problem) {
    throw new Error(`Refusing to sign sessions: ${problem}. ${AUTH_SECRET_HELP}`);
  }
  return secret;
}
