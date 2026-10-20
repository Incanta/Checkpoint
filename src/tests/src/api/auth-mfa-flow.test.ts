/**
 * The real better-auth instance from server/auth/config.ts (the other suites
 * stub it), against the test database: TOTP enrollment and the second-factor
 * step of a password sign-in, which need the TwoFactor table and
 * User.twoFactorEnabled to match what the plugin writes, and the guards on
 * the passkey endpoints.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";

import { resetConfig, setConfig, testConfigShim } from "../harness/config";
import { createTestDb, type TestDb } from "../harness/db";
import { getMfaStatuses } from "~/server/auth/mfa";

type AuthModule = typeof import("~/server/auth/config");

/** The Cookie header a browser would send back after these Set-Cookies. */
function cookieFrom(headers: Headers, previous = ""): string {
  const jar = new Map<string, string>();
  for (const pair of previous.split("; ").filter(Boolean)) {
    const [name, ...rest] = pair.split("=");
    jar.set(name!, rest.join("="));
  }
  for (const setCookie of headers.getSetCookie()) {
    const [pair] = setCookie.split(";");
    const [name, ...rest] = pair!.split("=");
    jar.set(name!, rest.join("="));
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function currentTotp(totpURI: string): Promise<string> {
  const encoded = new URL(totpURI).searchParams.get("secret")!;
  const secret = new TextDecoder().decode(base32.decode(encoded));
  return createOTP(secret).totp();
}

describe("better-auth MFA flows", () => {
  let testDb: TestDb;
  let db: TestDb["client"];
  let auth: Awaited<AuthModule["auth"]>;
  let actual: AuthModule;

  beforeAll(async () => {
    testDb = await createTestDb();
    db = testDb.client;
    globalThis.__checkpointTestDb = db;
    actual = await vi.importActual<AuthModule>("~/server/auth/config");
    auth = await actual.auth;
  }, 120_000);

  afterAll(async () => {
    await testDb.teardown();
    delete globalThis.__checkpointTestDb;
  });

  beforeEach(async () => {
    await testDb.reset();
  });

  const email = "first@test.local";
  const password = "correct horse battery";

  /** Registers the instance's first user (always allowed) and signs in. */
  async function signUp(): Promise<{ userId: string; cookie: string }> {
    const result = await auth.api.signUpEmail({
      body: { email, password, name: "First" },
      returnHeaders: true,
    });
    return {
      userId: result.response.user.id,
      cookie: cookieFrom(result.headers),
    };
  }

  async function enrollTotp(cookie: string): Promise<string> {
    const headers = new Headers({ cookie });
    const enabled = await auth.api.enableTwoFactor({
      body: { password },
      headers,
    });
    if (!("totpURI" in enabled)) throw new Error("expected a TOTP URI");
    await auth.api.verifyTOTP({
      body: { code: await currentTotp(enabled.totpURI) },
      headers,
    });
    return enabled.totpURI;
  }

  it("TOTP enrollment marks the user as meeting the requirement", async () => {
    const { userId, cookie } = await signUp();
    expect((await getMfaStatuses(db, [userId])).get(userId)?.compliant).toBe(
      false,
    );

    await enrollTotp(cookie);

    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.twoFactorEnabled).toBe(true);
    expect(await db.twoFactor.count({ where: { userId } })).toBe(1);
    expect((await getMfaStatuses(db, [userId])).get(userId)).toMatchObject({
      compliant: true,
      method: "totp",
    });
  });

  it("a password sign-in then stops at the second factor until the code is given", async () => {
    const { userId, cookie } = await signUp();
    const totpURI = await enrollTotp(cookie);
    const sessionsBefore = await db.session.count({ where: { userId } });

    const signIn = await auth.api.signInEmail({
      body: { email, password },
      asResponse: true,
    });
    const body = (await signIn.json()) as { twoFactorRedirect?: boolean };
    expect(body.twoFactorRedirect).toBe(true);
    expect(await db.session.count({ where: { userId } })).toBe(sessionsBefore);

    const twoFactorCookie = cookieFrom(signIn.headers);
    await expect(
      auth.api.verifyTOTP({
        body: { code: "000000" },
        headers: new Headers({ cookie: twoFactorCookie }),
      }),
    ).rejects.toThrow();

    await auth.api.verifyTOTP({
      body: { code: await currentTotp(totpURI) },
      headers: new Headers({ cookie: twoFactorCookie }),
    });
    expect(await db.session.count({ where: { userId } })).toBe(
      sessionsBefore + 1,
    );
  });

  describe("identity provider client secrets", () => {
    afterEach(() => {
      vi.restoreAllMocks();
      resetConfig();
    });

    it("resolves secret references for the enabled providers only", async () => {
      setConfig("auth.okta.enabled", true);
      setConfig("auth.okta.client.secret", "secret|okta_client_secret");
      setConfig("auth.google.enabled", true);
      setConfig("auth.google.client.secret", "plain-google-secret");
      setConfig("auth.keycloak.enabled", false);
      setConfig("auth.keycloak.client.secret", "secret|keycloak_client_secret");
      const resolve = vi
        .spyOn(testConfigShim, "processSecrets")
        .mockImplementation(async (value: string) =>
          value === "secret|okta_client_secret" ? "resolved-okta" : value,
        );

      const secrets = await actual.resolveClientSecrets();

      expect(secrets.okta).toBe("resolved-okta");
      expect(secrets.google).toBe("plain-google-secret");
      expect(secrets).not.toHaveProperty("keycloak");
      expect(resolve).not.toHaveBeenCalledWith("secret|keycloak_client_secret");
    });

    it("leaves an enabled provider without a secret empty", async () => {
      setConfig("auth.oidc.enabled", true);
      setConfig("auth.oidc.client.secret", "");
      const resolve = vi.spyOn(testConfigShim, "processSecrets");
      expect((await actual.resolveClientSecrets()).oidc).toBe("");
      expect(resolve).not.toHaveBeenCalled();
    });
  });

  describe("passkey guards", () => {
    async function makePasskey(userId: string, id: string) {
      return db.passkey.create({
        data: {
          id,
          userId,
          publicKey: "pk",
          credentialID: `cred-${id}`,
          counter: 0,
          deviceType: "multiDevice",
          backedUp: true,
        },
      });
    }

    async function dropPassword(userId: string) {
      await db.account.deleteMany({
        where: { userId, providerId: "credential" },
      });
    }

    it("a password user may register a passkey", async () => {
      const { cookie } = await signUp();
      const options = await auth.api.generatePasskeyRegistrationOptions({
        headers: new Headers({ cookie }),
      });
      expect(options.challenge).toEqual(expect.any(String));
    });

    it("an identity-provider-only user may not", async () => {
      const { userId, cookie } = await signUp();
      await dropPassword(userId);
      await db.account.create({
        data: { userId, accountId: "okta-1", providerId: "okta" },
      });
      await expect(
        auth.api.generatePasskeyRegistrationOptions({
          headers: new Headers({ cookie }),
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it("a passwordless user may not delete their only passkey", async () => {
      const { userId, cookie } = await signUp();
      await dropPassword(userId);
      await makePasskey(userId, "only");
      await expect(
        auth.api.deletePasskey({
          body: { id: "only" },
          headers: new Headers({ cookie }),
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(await db.passkey.count({ where: { userId } })).toBe(1);
    });

    it("but may delete one of two", async () => {
      const { userId, cookie } = await signUp();
      await dropPassword(userId);
      await makePasskey(userId, "one");
      await makePasskey(userId, "two");
      await auth.api.deletePasskey({
        body: { id: "one" },
        headers: new Headers({ cookie }),
      });
      expect(await db.passkey.count({ where: { userId } })).toBe(1);
    });

    it("a user with a password may delete their only passkey", async () => {
      const { userId, cookie } = await signUp();
      await makePasskey(userId, "only");
      await auth.api.deletePasskey({
        body: { id: "only" },
        headers: new Headers({ cookie }),
      });
      expect(await db.passkey.count({ where: { userId } })).toBe(0);
    });
  });
});
