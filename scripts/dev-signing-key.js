/**
 * The storage signing key for local development.
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

function devStorageSigningKey() {
  if (process.env[ENV_NAME]) {
    return process.env[ENV_NAME];
  }

  try {
    const existing = fs.readFileSync(KEY_FILE, "utf-8").trim();
    if (existing.length >= 32) {
      return existing;
    }
  } catch {
    // Not generated yet.
  }

  const key = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, key + "\n", { mode: 0o600 });
  return key;
}

module.exports = { devStorageSigningKey, ENV_NAME };
