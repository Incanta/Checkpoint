/**
 * The rules for what the storage server accepts as a key, and as a signing
 * key. These are the pure halves of the checks the integration suite drives
 * over HTTP (src/integration/gateway-scope.test.ts), covered here so they run
 * on every platform without services.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  isCanonicalKey,
  isSafeSegment,
  isUnder,
  keyFromRequestPath,
} from "../../../core/server/src/utils/storage-key.js";
import {
  SIGNING_KEY_ENV,
  signingKeyProblem,
  storageSigningKey,
} from "../../../core/server/src/utils/signing-key.js";
import { signingKeyProblem as appSigningKeyProblem } from "~/server/storage-signing-key";

describe("storage keys", () => {
  it.each([
    "/org/repo/store.lsi",
    "/org/repo/chunks/ab12/0x00ab12cd34ef5678.lrb",
    `/org/repo/versions/${"a".repeat(64)}.lvi`,
    "/cmv6a5bre001qoblkludjs32k/cmv6a5bwk001uoblks2amn7yl/tree/abc",
    "/org/repo",
    "/a/b/c_d-e.f",
  ])("accepts %s", (key) => {
    expect(isCanonicalKey(key)).toBe(true);
    expect(keyFromRequestPath(key)).toBe(key);
  });

  it.each([
    ["no leading slash", "org/repo/store.lsi"],
    ["empty", ""],
    ["root", "/"],
    ["parent segment", "/org/repo/../other/store.lsi"],
    ["leading parent segment", "/../org/repo"],
    ["trailing parent segment", "/org/repo/.."],
    ["current segment", "/org/repo/./store.lsi"],
    ["empty segment", "/org/repo//store.lsi"],
    ["trailing slash", "/org/repo/store.lsi/"],
    ["backslash", "/org/repo\\..\\..\\other"],
    ["NUL", "/org/repo/store.lsi\0.txt"],
    ["newline", "/org/repo/store\n.lsi"],
    ["space", "/org/repo/a b"],
    ["percent", "/org/repo/%2e%2e"],
    ["alternate data stream", "/org/repo/store.lsi::$DATA"],
    ["drive letter", "/org/repo/C:"],
    ["trailing dot", "/org/repo/store.lsi."],
    ["three dots", "/org/repo/..."],
    ["unicode slash lookalike", "/org/repo/a∕b"],
    ["unicode dot lookalike", "/org/repo/．．/x"],
    ["tilde", "/org/repo/~"],
  ])("refuses a key with %s", (_name, key) => {
    expect(isCanonicalKey(key)).toBe(false);
  });

  it("refuses over-long segments and keys", () => {
    expect(isSafeSegment("a".repeat(255))).toBe(true);
    expect(isSafeSegment("a".repeat(256))).toBe(false);
    expect(isCanonicalKey("/" + Array(12).fill("a".repeat(100)).join("/"))).toBe(false);
  });

  it.each([
    ["/org/repo/%2e%2e/%2e%2e/other/repo/store.lsi", null],
    ["/org/repo/..%2f..%2fother/repo/store.lsi", null],
    ["/org/repo/..%5c..%5cother", null],
    ["/org/repo/%252e%252e/x", null],
    ["/org/repo/%00", null],
    ["/org/repo/%zz", null],
    ["/org/repo/%E0%A4%A", null],
    ["/org/repo/store%2Elsi", "/org/repo/store.lsi"],
    ["/org/repo/chunks%2Fab12%2Fx.lrb", "/org/repo/chunks/ab12/x.lrb"],
  ])("decodes %s once and then judges the result", (raw, expected) => {
    expect(keyFromRequestPath(raw)).toBe(expected);
  });

  it("scopes by whole segments, not by string prefix", () => {
    expect(isUnder("/org/repo", "/org/repo")).toBe(true);
    expect(isUnder("/org/repo/store.lsi", "/org/repo")).toBe(true);
    expect(isUnder("/org/repo2/store.lsi", "/org/repo")).toBe(false);
    expect(isUnder("/org/repo-other", "/org/repo")).toBe(false);
    expect(isUnder("/org", "/org/repo")).toBe(false);
    expect(isUnder("/ORG/REPO/store.lsi", "/org/repo")).toBe(false);
  });
});

describe("storage signing key", () => {
  const saved = process.env[SIGNING_KEY_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[SIGNING_KEY_ENV];
    else process.env[SIGNING_KEY_ENV] = saved;
  });

  const good = "3f9c1e7ab4d2805566f0c1e2a9b8d7f4a1c3e5b7092d4f6a8c0e1b3d5f7a9c2e";

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["not a string", 12345678901234567890123456789012],
    ["the old default", "secret"],
    ["the old default in capitals", "SECRET"],
    ["a placeholder", "changeme"],
    ["the old test key", "test-jwt-secret"],
    ["31 characters", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d"],
    ["one repeated character", "a".repeat(64)],
    ["two alternating characters", "ab".repeat(32)],
  ])("refuses a key that is %s", (_name, key) => {
    expect(signingKeyProblem(key)).not.toBeNull();
    expect(appSigningKeyProblem(key)).not.toBeNull();
  });

  it("accepts a random 32 byte key", () => {
    expect(signingKeyProblem(good)).toBeNull();
    expect(appSigningKeyProblem(good)).toBeNull();
    expect(signingKeyProblem(good.slice(0, 32))).toBeNull();
  });

  it("reads the key from the environment first, and throws rather than return a weak one", () => {
    process.env[SIGNING_KEY_ENV] = good;
    expect(storageSigningKey()).toBe(good);

    process.env[SIGNING_KEY_ENV] = "secret";
    expect(() => storageSigningKey()).toThrow(/placeholder/);

    process.env[SIGNING_KEY_ENV] = "short";
    expect(() => storageSigningKey()).toThrow(/too short/);
  });

  it("names the setting to change in the error", () => {
    process.env[SIGNING_KEY_ENV] = "secret";
    expect(() => storageSigningKey()).toThrow(/CHECKPOINT_STORAGE_SIGNING_KEY/);
  });
});
