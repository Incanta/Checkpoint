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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const {
  checkBundle,
  assetName,
  manifestUrl,
  releaseAssetUrl,
  resolveCommand,
  configuredEnv,
} = require("../../../../docker/runtime/bootstrap.js") as {
    checkBundle: (
      manifest: Record<string, unknown>,
      archiveSha256: string,
      context: { component: string; runtimeAbi: string; dbProvider: string },
    ) => Promise<unknown>;
    assetName: (version: string) => string;
    manifestUrl: () => string;
    releaseAssetUrl: (tag: string, asset: string) => string;
    resolveCommand: (
      dir: string,
      command: string[],
    ) => { file: string; args: string[] };
    configuredEnv: (
      dir: string,
      configDir: string | null,
    ) => Promise<Record<string, string>>;
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

/**
 * The bundle's start and migrate commands are looked up inside the bundle, not
 * on PATH: the runtime image deliberately ships no CLIs of its own, and a
 * bundle staged with fs.cpSync does not reliably carry node_modules/.bin. A
 * regression here is a container that boots and then dies on `spawnSync prisma
 * ENOENT`, which is exactly what these pin.
 */
describe("resolveCommand", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-bundle-"));

  const writePackage = (name: string, bin: unknown, entry: string): void => {
    const pkgDir = path.join(root, "node_modules", name);
    fs.mkdirSync(path.join(pkgDir, path.dirname(entry)), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, entry), "// entry\n");
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name, bin }),
    );
  };

  it("runs node commands with this interpreter, not a PATH lookup", () => {
    expect(resolveCommand(root, ["node", "src/app/server.js"])).toEqual({
      file: process.execPath,
      args: ["src/app/server.js"],
    });
  });

  it("resolves a bundled CLI through its package.json bin map", () => {
    writePackage("prisma", { prisma: "build/index.js" }, "build/index.js");
    expect(resolveCommand(root, ["prisma", "migrate", "deploy"])).toEqual({
      file: process.execPath,
      args: [
        path.join(root, "node_modules", "prisma", "build", "index.js"),
        "migrate",
        "deploy",
      ],
    });
  });

  it("resolves a bundled CLI whose bin is a bare string", () => {
    writePackage("solo", "cli.js", "cli.js");
    expect(resolveCommand(root, ["solo", "--go"])).toEqual({
      file: process.execPath,
      args: [path.join(root, "node_modules", "solo", "cli.js"), "--go"],
    });
  });

  it("falls back to PATH when the bundle carries no such package", () => {
    expect(resolveCommand(root, ["absent", "--x"])).toEqual({
      file: "absent",
      args: ["--x"],
    });
  });
});

/**
 * Checkpoint keeps DATABASE_URL (and PORT, and the external URL) in config, but
 * Prisma and Next read them from the environment. The old images bridged the
 * two by launching everything through @incanta/config's `config-env`; the
 * bootstrap now does it in-process. If this bridge breaks, the app boots and
 * then cannot reach its database.
 *
 * The repo root stands in for an extracted bundle here: both have
 * node_modules/@incanta/config alongside the component's config directory,
 * which is the only structure the function cares about.
 */
describe("configuredEnv", () => {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../..",
  );

  it("maps config keys onto the env vars the app actually reads", async () => {
    const previous = process.env.NODE_CONFIG_ENV;
    process.env.NODE_CONFIG_ENV = "default";
    try {
      const env = await configuredEnv(
        repoRoot,
        path.join(repoRoot, "src/app/config"),
      );
      // The names are the contract; the values come from whatever the operator
      // mounted, so only their presence is asserted.
      expect(Object.keys(env).sort()).toEqual([
        "DATABASE_URL",
        "DB_PROVIDER",
        "NEXT_PUBLIC_EXTERNAL_URL",
        "PORT",
      ]);
      expect(env.DATABASE_URL).toBeTruthy();
    } finally {
      if (previous === undefined) delete process.env.NODE_CONFIG_ENV;
      else process.env.NODE_CONFIG_ENV = previous;
    }
  });

  it("returns nothing for a component with no config directory", async () => {
    await expect(configuredEnv(repoRoot, null)).resolves.toEqual({});
  });

  it("degrades to an empty map when the bundle carries no @incanta/config", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "cp-noconfig-"));
    await expect(configuredEnv(empty, path.join(empty, "config"))).resolves.toEqual(
      {},
    );
  });
});
