/**
 * The auth secret signs every session cookie. It has no default, and a
 * missing, short, or placeholder one (including the value the config used to
 * ship) is refused, so an instance that never set it cannot run with
 * sessions anyone could forge.
 */
import { afterEach, describe, expect, it } from "vitest";

import { setConfig } from "../harness/config";
import {
  AUTH_SECRET_ENV,
  authSecret,
  authSecretProblem,
} from "~/server/auth-secret";

const GOOD = "3f9a1c7e5b2d8046a1f3c9e7b5d2a8046f1e3c9a7b5d2e80";

describe("authSecretProblem", () => {
  it("accepts a random value", () => {
    expect(authSecretProblem(GOOD)).toBeNull();
  });

  it.each([
    ["nothing", undefined],
    ["an empty string", ""],
    ["a number", 12345],
    ["the old shipped default", "betterauthsecretthatsatleast32characterslong"],
    ["the old default in capitals", "BETTERAUTHSECRETTHATSATLEAST32CHARACTERSLONG"],
    ["the Docker Compose template value", "changeme-betterauth-secret"],
    ["a placeholder", "changeme"],
    ["31 characters", GOOD.slice(0, 31)],
    ["a long run of one character", "a".repeat(64)],
    ["a long value with little variety", "abab".repeat(16)],
  ])("refuses %s", (_label, value) => {
    expect(authSecretProblem(value)).toEqual(expect.any(String));
  });

  it("accepts exactly 32 varied characters", () => {
    expect(authSecretProblem(GOOD.slice(0, 32))).toBeNull();
  });
});

describe("authSecret", () => {
  afterEach(() => {
    delete process.env[AUTH_SECRET_ENV];
  });

  it("reads auth.secret", async () => {
    setConfig("auth.secret", GOOD);
    expect(await authSecret()).toBe(GOOD);
  });

  it("prefers the environment variable", async () => {
    setConfig("auth.secret", "changeme");
    process.env[AUTH_SECRET_ENV] = GOOD;
    expect(await authSecret()).toBe(GOOD);
  });

  it("refuses an unset secret, and says how to set one", async () => {
    setConfig("auth.secret", "");
    await expect(authSecret()).rejects.toThrow(
      /no auth secret is configured.*CHECKPOINT_AUTH_SECRET.*openssl rand/,
    );
  });

  it("refuses the old shipped default", async () => {
    setConfig("auth.secret", "betterauthsecretthatsatleast32characterslong");
    await expect(authSecret()).rejects.toThrow(/well-known placeholder/);
  });

  it("falls back to auth.secret when the variable is empty", async () => {
    process.env[AUTH_SECRET_ENV] = "";
    setConfig("auth.secret", GOOD);
    expect(await authSecret()).toBe(GOOD);
  });
});
