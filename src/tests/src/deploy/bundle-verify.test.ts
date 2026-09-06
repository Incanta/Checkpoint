/**
 * Bundle trust and compatibility checks.
 *
 * The runtime container downloads a bundle and executes it, so these checks are
 * the entire barrier between a compromised or mismatched release asset and code
 * running as the server. They also gate the compatibility failures that are
 * worst to debug in the field: a bundle built against a different Node ABI
 * surfaces as a segfault loading the longtail addon, and an app bundle built
 * for the wrong Prisma provider surfaces as confusing migration errors.
 *
 * The subjects are plain CommonJS from the runtime image
 * (docker/runtime/bootstrap.js, scripts/bundle/signing.js), imported directly
 * so the tests exercise the same code the container ships.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);

const { checkBundle, assetName, manifestUrl, releaseAssetUrl } = require(
  "../../../../docker/runtime/bootstrap.js",
) as {
  checkBundle: (
    manifest: Record<string, unknown>,
    archiveSha256: string,
    context: { component: string; runtimeAbi: string; dbProvider: string },
  ) => Promise<unknown>;
  assetName: (version: string) => string;
  manifestUrl: () => string;
  releaseAssetUrl: (tag: string, asset: string) => string;
};

const { signManifest, verifySidecar } = require(
  "../../../../scripts/bundle/signing.js",
) as {
  signManifest: (
    manifest: unknown,
    privateKeyB64: string,
  ) => { manifest: string; signature: string };
  verifySidecar: (
    sidecar: unknown,
    publicKey: crypto.KeyObject,
  ) => Promise<Record<string, unknown>>;
};

const ABI = "node24-debian12-openssl3";

function manifestFor(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1,
    component: "server",
    version: "0.5.0",
    provider: null,
    runtimeAbi: ABI,
    archive: "checkpoint-bundle-server-0.5.0.tar.zst",
    sha256: "a".repeat(64),
    ...overrides,
  };
}

const context = {
  component: "server",
  runtimeAbi: ABI,
  dbProvider: "sqlite",
};

describe("checkBundle", () => {
  it("accepts a matching bundle", async () => {
    await expect(
      checkBundle(manifestFor(), "a".repeat(64), context),
    ).resolves.toBeTruthy();
  });

  it("rejects an archive whose contents do not match the signed hash", async () => {
    // The signature covers the manifest, and the manifest covers the archive
    // hash. Without this check, a signed manifest could be paired with a
    // swapped archive.
    await expect(
      checkBundle(manifestFor(), "b".repeat(64), context),
    ).rejects.toThrow(/hash mismatch/);
  });

  it("rejects a bundle built for the other component", async () => {
    await expect(
      checkBundle(manifestFor({ component: "app" }), "a".repeat(64), context),
    ).rejects.toThrow(/this container runs "server"/);
  });

  it("rejects a bundle built against a different runtime ABI", async () => {
    await expect(
      checkBundle(
        manifestFor({ runtimeAbi: "node22-debian11-openssl1" }),
        "a".repeat(64),
        context,
      ),
    ).rejects.toThrow(/runtime ABI/);
  });

  it("rejects an app bundle built for the wrong database provider", async () => {
    await expect(
      checkBundle(
        manifestFor({ component: "app", provider: "postgresql" }),
        "a".repeat(64),
        { ...context, component: "app", dbProvider: "sqlite" },
      ),
    ).rejects.toThrow(/postgresql/);
  });

  it("allows a bundle that declares no ABI, for forward compatibility", async () => {
    await expect(
      checkBundle(manifestFor({ runtimeAbi: null }), "a".repeat(64), context),
    ).resolves.toBeTruthy();
  });
});

describe("bundle signatures", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const privateKeyB64 = privateKey
    .export({ type: "pkcs8", format: "der" })
    .toString("base64");

  it("round-trips a signed manifest", async () => {
    const sidecar = signManifest(manifestFor(), privateKeyB64);
    const parsed = await verifySidecar(sidecar, publicKey);
    expect(parsed.version).toBe("0.5.0");
  });

  it("rejects a manifest edited after signing", async () => {
    const sidecar = signManifest(manifestFor(), privateKeyB64);
    const tampered = {
      ...sidecar,
      manifest: sidecar.manifest.replace("0.5.0", "9.9.9"),
    };
    await expect(verifySidecar(tampered, publicKey)).rejects.toThrow(
      /not valid/,
    );
  });

  it("rejects a signature from a key that is not the published one", async () => {
    const attacker = crypto.generateKeyPairSync("ed25519");
    const sidecar = signManifest(
      manifestFor(),
      attacker.privateKey.export({ type: "pkcs8", format: "der" }).toString(
        "base64",
      ),
    );
    await expect(verifySidecar(sidecar, publicKey)).rejects.toThrow(/not valid/);
  });

  it("rejects a sidecar with no signature at all", async () => {
    await expect(
      verifySidecar(
        { manifest: JSON.stringify(manifestFor()), signature: null },
        publicKey,
      ),
    ).rejects.toThrow(/malformed/);
  });
});

describe("asset and URL naming", () => {
  it("names server assets by version", () => {
    // assetName reads CHECKPOINT_COMPONENT, which the test env leaves unset;
    // it defaults to the server shape.
    expect(assetName("0.5.0")).toBe("checkpoint-bundle-server-0.5.0.tar.zst");
  });

  it("points at the rolling tag for nightly and the latest redirect otherwise", () => {
    expect(manifestUrl()).toContain("releases/latest/download");
    expect(releaseAssetUrl("v0.5.0", "x.tar.zst")).toBe(
      "https://github.com/Incanta/Checkpoint/releases/download/v0.5.0/x.tar.zst",
    );
  });
});
