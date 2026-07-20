import crypto from "node:crypto";
import config from "@incanta/config";
import { Logger } from "./logging";

// AES-256-GCM encryption for third-party secrets stored at rest (e.g. issue
// tracker API tokens). Payload format: "v1:<iv-b64>:<tag-b64>:<ct-b64>".

const PAYLOAD_VERSION = "v1";
const IV_LENGTH = 12;

const ENCRYPTION_KEY_CACHE = Symbol.for("checkpoint.secretEncryptionKey");

const globalForEncryptionKey = globalThis as unknown as {
  [ENCRYPTION_KEY_CACHE]?: Buffer;
};

async function getEncryptionKey(): Promise<Buffer> {
  const cached = globalForEncryptionKey[ENCRYPTION_KEY_CACHE];
  if (cached) {
    return cached;
  }

  let key: Buffer;

  const configuredSource = config.tryGet<string>("security.encryption-key");
  const configured = configuredSource
    ? await config.processSecrets(configuredSource)
    : null;

  if (configured) {
    key = Buffer.from(configured, "base64");
    if (key.length !== 32) {
      throw new Error(
        "security.encryption-key must be 32 bytes, base64-encoded (e.g. `openssl rand -base64 32`)",
      );
    }
  } else {
    const authSecret = await config.getWithSecrets<string>("auth.secret");
    key = Buffer.from(
      crypto.hkdfSync(
        "sha256",
        Buffer.from(authSecret),
        Buffer.from("checkpoint-security-v1"),
        Buffer.from("issue-tracker-secrets"),
        32,
      ),
    );
    Logger.warn(
      "[Security] security.encryption-key is not set; deriving a secret encryption key from auth.secret. Rotating auth.secret will invalidate stored integration secrets.",
    );
  }

  globalForEncryptionKey[ENCRYPTION_KEY_CACHE] = key;
  return key;
}

export async function encryptSecret(plaintext: string): Promise<string> {
  const key = await getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    PAYLOAD_VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export async function decryptSecret(payload: string): Promise<string> {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== PAYLOAD_VERSION) {
    throw new Error("Unrecognized encrypted payload format");
  }
  const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  const key = await getEncryptionKey();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
