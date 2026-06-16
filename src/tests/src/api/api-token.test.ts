// Tests for `apiToken` router: device-code pairing flow (getCode →
// createApiToken → getApiToken), token listing, and revocation.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { createTestDb, type TestDb } from "../harness/db";
import { makeUser, makeApiToken } from "../harness/fixtures";
import { makeAppCaller } from "../harness/caller";

describe("apiToken router", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
    globalThis.__checkpointTestDb = testDb.client;
  }, 120_000);

  afterAll(async () => {
    await testDb.teardown();
    delete globalThis.__checkpointTestDb;
  });

  beforeEach(async () => {
    await testDb.reset();
  });

  describe("getCode", () => {
    it("returns a 6-char uppercase-alphanumeric code", async () => {
      const caller = await makeAppCaller();
      const { code } = await caller.apiToken.getCode();
      expect(code).toMatch(/^[A-Z0-9]{6}$/);
    });
  });

  describe("device pairing flow", () => {
    it("createApiToken + getApiToken hands the token to the device and clears the code", async () => {
      const user = await makeUser(testDb.client);
      const authed = await makeAppCaller({ asUser: user });
      const unauthed = await makeAppCaller();

      const { code } = await authed.apiToken.getCode();
      await authed.apiToken.createApiToken({
        name: "laptop",
        deviceCode: code,
        expiresAt: null,
      });

      const { apiToken } = await unauthed.apiToken.getApiToken({ code });
      expect(apiToken).toMatch(/^[a-f0-9]{64}$/);

      // The code is single-use — second call must fail.
      await expect(
        unauthed.apiToken.getApiToken({ code }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("getApiToken rejects expired tokens with NOT_FOUND", async () => {
      const user = await makeUser(testDb.client);
      await makeApiToken(testDb.client, user.id, {
        deviceCode: "EXPIRED",
        expiresAt: new Date(Date.now() - 60 * 1000),
      });
      const unauthed = await makeAppCaller();
      await expect(
        unauthed.apiToken.getApiToken({ code: "EXPIRED" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("getApiToken rejects unknown codes with NOT_FOUND", async () => {
      const unauthed = await makeAppCaller();
      await expect(
        unauthed.apiToken.getApiToken({ code: "ZZZZZZ" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("getActiveDevices", () => {
    it("returns only the caller's non-expired tokens, redacted", async () => {
      const alice = await makeUser(testDb.client);
      const bob = await makeUser(testDb.client);
      await makeApiToken(testDb.client, alice.id, {
        name: "alice-laptop",
        deviceCode: "AAAAAA",
      });
      await makeApiToken(testDb.client, alice.id, {
        name: "alice-expired",
        expiresAt: new Date(Date.now() - 60 * 1000),
      });
      await makeApiToken(testDb.client, bob.id, { name: "bob-phone" });

      const caller = await makeAppCaller({ asUser: alice });
      const res = await caller.apiToken.getActiveDevices();

      expect(res.activeDevices.map((d) => d.name)).toEqual(["alice-laptop"]);
      // Sensitive fields wiped before return.
      expect(res.activeDevices[0]?.token).toBe("");
      expect(res.activeDevices[0]?.deviceCode).toBeNull();
    });

    it("requires authentication", async () => {
      const caller = await makeAppCaller();
      await expect(caller.apiToken.getActiveDevices()).rejects.toThrow(
        /UNAUTHORIZED/,
      );
    });
  });

  describe("revokeDevice", () => {
    it("sets expiresAt to now so the token stops being returned as active", async () => {
      const user = await makeUser(testDb.client);
      const tok = await makeApiToken(testDb.client, user.id, {
        name: "to-revoke",
      });

      const caller = await makeAppCaller({ asUser: user });
      await caller.apiToken.revokeDevice({ deviceId: tok.id });

      const row = await testDb.client.apiToken.findUniqueOrThrow({
        where: { id: tok.id },
      });
      expect(row.expiresAt).not.toBeNull();
      expect(row.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

      const active = await caller.apiToken.getActiveDevices();
      expect(active.activeDevices).toEqual([]);
    });

    it("cannot revoke another user's token", async () => {
      const alice = await makeUser(testDb.client);
      const bob = await makeUser(testDb.client);
      const bobsToken = await makeApiToken(testDb.client, bob.id);

      const caller = await makeAppCaller({ asUser: alice });
      // Prisma throws when WHERE returns 0 rows on a unique update.
      await expect(
        caller.apiToken.revokeDevice({ deviceId: bobsToken.id }),
      ).rejects.toThrow();

      // Bob's token remains valid.
      const row = await testDb.client.apiToken.findUniqueOrThrow({
        where: { id: bobsToken.id },
      });
      expect(row.expiresAt).toBeNull();
    });
  });
});
