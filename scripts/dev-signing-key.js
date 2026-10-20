/**
 * The storage signing key (and the app's auth secret) for local development.
 *
 * The app and the core server refuse to start without a real signing key (see
 * src/core/server/src/utils/signing-key.ts), and they have to agree on it. The
 * dev scripts call this to hand both the same one through
 * CHECKPOINT_STORAGE_SIGNING_KEY.
 *
 * A key already in the environment is used as is. Otherwise one is generated
 * on first use and kept in logs/ (which is gitignored), so it is unique to
 * this checkout and stable across restarts: tokens issued before a restart
 * keep working.
 *
 * This is for development only. A deployment sets its own key.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ENV_NAME = "CHECKPOINT_STORAGE_SIGNING_KEY";
const KEY_FILE = path.join(__dirname, "..", "logs", ".dev-storage-signing-key");

// The app's auth secret (src/app/src/server/auth-secret.ts) works the same
// way: no default, so the dev scripts hand the app one.
const AUTH_SECRET_ENV = "CHECKPOINT_AUTH_SECRET";
const AUTH_SECRET_FILE = path.join(__dirname, "..", "logs", ".dev-auth-secret");

function devKey(envName, file) {
  if (process.env[envName]) {
    return process.env[envName];
  }

  try {
    const existing = fs.readFileSync(file, "utf-8").trim();
    if (existing.length >= 32) {
      return existing;
    }
  } catch {
    // Not generated yet.
  }

  const key = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, key + "\n", { mode: 0o600 });
  return key;
}

function devStorageSigningKey() {
  return devKey(ENV_NAME, KEY_FILE);
}

/** Stable across restarts, so dev sessions survive one. */
function devAuthSecret() {
  return devKey(AUTH_SECRET_ENV, AUTH_SECRET_FILE);
}

module.exports = {
  devStorageSigningKey,
  devAuthSecret,
  ENV_NAME,
  AUTH_SECRET_ENV,
};
