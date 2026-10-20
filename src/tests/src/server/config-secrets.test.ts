/**
 * Config values that hold secrets may be secret references
 * ("secret|<name>"), resolved through the secrets provider before use: the
 * Stripe keys, and the core server's segment index key. A reference must
 * never be used as the secret itself.
 */
import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetConfig, setConfig, testConfigShim } from "../harness/config";
import {
  disableLicenseManager,
  enableLicenseManager,
} from "../billing/harness/gates";
import {
  INDEX_KEY_ENV,
  forgetLoadedStorageIndexKey,
  indexObjectName,
  loadStorageIndexKey,
} from "../../../core/server/src/storage/index-segments.js";
import {
  getStripeClient,
  getStripePublishableKey,
  getStripeWebhookSecret,
  resetStripeClient,
} from "~/server/stripe/client";

// The core server's logger reads its whole config at import; these tests
// only need it silent.
vi.mock("../../../core/server/src/logging.js", () => ({
  Logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

/** Resolves `reference` to `value` and passes anything else through. */
function resolving(reference: string, value: string) {
  return vi
    .spyOn(testConfigShim, "processSecrets")
    .mockImplementation(async (v: string) => (v === reference ? value : v));
}

describe("Stripe secrets", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetConfig();
    resetStripeClient();
    disableLicenseManager();
  });

  it("resolves the webhook secret", async () => {
    setConfig("stripe.webhook-secret", "secret|stripe_webhook_secret");
    resolving("secret|stripe_webhook_secret", "whsec_resolved");
    expect(await getStripeWebhookSecret()).toBe("whsec_resolved");
  });

  it("resolves the publishable key", async () => {
    setConfig("stripe.publishable-key", "secret|stripe_publishable_key");
    resolving("secret|stripe_publishable_key", "pk_test_resolved");
    expect(await getStripePublishableKey()).toBe("pk_test_resolved");
  });

  it("passes plain values through and leaves unset ones empty", async () => {
    setConfig("stripe.webhook-secret", "whsec_plain");
    setConfig("stripe.publishable-key", "");
    const resolve = vi.spyOn(testConfigShim, "processSecrets");
    expect(await getStripeWebhookSecret()).toBe("whsec_plain");
    expect(await getStripePublishableKey()).toBe("");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("builds the client from the resolved secret key", async () => {
    enableLicenseManager();
    setConfig("stripe.enabled", true);
    setConfig("stripe.secret-key", "secret|stripe_secret_key");
    const resolve = resolving("secret|stripe_secret_key", "sk_test_resolved");
    expect(await getStripeClient()).toBeDefined();
    expect(resolve).toHaveBeenCalledWith("secret|stripe_secret_key");
  });

  it("refuses a secret key that resolves to nothing", async () => {
    enableLicenseManager();
    setConfig("stripe.enabled", true);
    setConfig("stripe.secret-key", "secret|stripe_secret_key");
    resolving("secret|stripe_secret_key", "");
    await expect(getStripeClient()).rejects.toThrow(/not configured/);
  });
});

describe("the core server's segment index key", () => {
  const key = "9d2f4b6a8c0e1f3a5b7c9d1e3f5a7b9c0d2e4f6a8b0c1d3e5f7a9b1c3d5e7f9a";
  const saved = process.env[INDEX_KEY_ENV];

  /** The name an index object with this content has under `macKey`. */
  function expectedName(macKey: string, repoId: string, buffer: Buffer) {
    const sha = createHash("sha256").update(buffer).digest("hex");
    const mac = createHmac("sha256", macKey)
      .update(`${repoId}:${sha}`)
      .digest("hex")
      .slice(0, 16);
    return `${sha}-${mac}.lsi`;
  }

  function expectMacKey(macKey: string, buffer: Buffer) {
    expect(indexObjectName("repo", buffer)).toBe(
      expectedName(macKey, "repo", buffer),
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
    resetConfig();
    forgetLoadedStorageIndexKey();
    if (saved === undefined) delete process.env[INDEX_KEY_ENV];
    else process.env[INDEX_KEY_ENV] = saved;
  });

  it("refuses to MAC with a reference that was never resolved", () => {
    delete process.env[INDEX_KEY_ENV];
    setConfig("storage.index.signing-key", "secret|storage_index_key");
    expect(() => indexObjectName("repo", Buffer.from("x"))).toThrow(
      /secret reference/,
    );
  });

  it("MACs with the resolved value once loaded", async () => {
    delete process.env[INDEX_KEY_ENV];
    setConfig("storage.index.signing-key", "secret|storage_index_key");
    const resolve = resolving("secret|storage_index_key", key);
    await loadStorageIndexKey();
    expectMacKey(key, Buffer.from("x"));
    expectMacKey(key, Buffer.from("y"));
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("still lets the environment variable win", async () => {
    setConfig("storage.index.signing-key", "secret|storage_index_key");
    resolving("secret|storage_index_key", "z".repeat(8) + key);
    await loadStorageIndexKey();
    process.env[INDEX_KEY_ENV] = key;
    expectMacKey(key, Buffer.from("x"));
  });
});
