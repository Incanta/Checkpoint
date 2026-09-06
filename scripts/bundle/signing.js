// Ed25519 signing and verification for deployment bundles.
//
// The runtime container downloads and executes bundle contents, so an
// unverified bundle is remote code execution on every deployment. Bundles are
// signed in CI with the Incanta private key and verified at boot against the
// public key published as a DNS TXT record, the same trust anchor the license
// manager already uses (src/app/src/server/license-utils.ts).
//
// The signed payload is the exact manifest *string*, and the sidecar ships that
// same string verbatim. Signing a serialization rather than an object sidesteps
// JSON canonicalization entirely: there is no way for the bytes that were
// verified to differ from the bytes that get parsed.
//
// CommonJS with zero dependencies so the runtime image can use it unchanged.

const crypto = require("crypto");
const dns = require("dns").promises;

/**
 * Trust anchor. Deliberately NOT read from the sidecar: a bundle that names its
 * own key host could simply point at a host the attacker controls. The env
 * override exists for testing against a staging key and is documented as
 * trusted input.
 */
const DEFAULT_KEY_HOST = "key.checkpointvcs.com";

function getKeyHost() {
  return process.env["CHECKPOINT_BUNDLE_KEY_HOST"] || DEFAULT_KEY_HOST;
}

/** Resolve the Ed25519 public key (base64 SPKI DER) from DNS. */
async function resolvePublicKey(keyHost = getKeyHost()) {
  const records = await dns.resolveTxt(keyHost);
  // TXT records arrive as arrays of chunks; join them the same way
  // license-utils.ts does.
  const base64 = records
    .map((chunks) => chunks.join(""))
    .join("")
    .trim();

  if (!base64) {
    throw new Error(`DNS TXT record for ${keyHost} is empty`);
  }

  return crypto.createPublicKey({
    key: Buffer.from(base64, "base64"),
    format: "der",
    type: "spki",
  });
}

/**
 * Sign a manifest object. Returns the sidecar contents.
 *
 * @param manifest       plain object describing the bundle
 * @param privateKeyB64  base64 PKCS8 DER Ed25519 private key
 */
function signManifest(manifest, privateKeyB64) {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(privateKeyB64, "base64"),
    format: "der",
    type: "pkcs8",
  });

  const manifestString = JSON.stringify(manifest);
  const signature = crypto.sign(
    null,
    Buffer.from(manifestString, "utf8"),
    privateKey,
  );

  return {
    schema: 1,
    manifest: manifestString,
    signature: signature.toString("base64"),
    // Informational only. Verification always uses the local trust anchor.
    keyHost: getKeyHost(),
  };
}

/**
 * Verify a sidecar and return the parsed manifest.
 * Throws if the signature does not check out.
 */
async function verifySidecar(sidecar, publicKey) {
  if (!sidecar || typeof sidecar.manifest !== "string" || !sidecar.signature) {
    throw new Error("malformed bundle signature file");
  }

  const key = publicKey ?? (await resolvePublicKey());

  const ok = crypto.verify(
    null,
    Buffer.from(sidecar.manifest, "utf8"),
    key,
    Buffer.from(sidecar.signature, "base64"),
  );

  if (!ok) {
    throw new Error("bundle signature is not valid for the published key");
  }

  return JSON.parse(sidecar.manifest);
}

/** Hash a file the way the manifest records it. */
function sha256File(filePath) {
  const fs = require("fs");
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

module.exports = {
  DEFAULT_KEY_HOST,
  getKeyHost,
  resolvePublicKey,
  signManifest,
  verifySidecar,
  sha256File,
};
