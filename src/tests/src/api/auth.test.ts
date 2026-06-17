// Tests for `auth` router: checkUsername / checkEmail / devLogin.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { TRPCError } from "@trpc/server";
import { createTestDb, type TestDb } from "../harness/db";
import { makeUser } from "../harness/fixtures";
import { makeAppCaller } from "../harness/caller";
import { setConfig } from "../harness/config";

describe("auth router", () => {
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

  describe("checkUsername", () => {
    it("returns available=true when no user owns the username", async () => {
      const caller = await makeAppCaller();
      const res = await caller.auth.checkUsername({ username: "ghost" });
      expect(res).toEqual({ available: true });
    });

    it("returns available=false when a user already owns it", async () => {
      await makeUser(testDb.client, {
        email: "claimed@test.local",
        username: "claimed",
      });
      const caller = await makeAppCaller();
      const res = await caller.auth.checkUsername({ username: "claimed" });
      expect(res.available).toBe(false);
    });

    it("rejects an empty username at zod validation", async () => {
      const caller = await makeAppCaller();
      await expect(
        caller.auth.checkUsername({ username: "" }),
      ).rejects.toThrow();
    });
  });

  describe("checkEmail", () => {
    it("returns available=true for an unused email", async () => {
      const caller = await makeAppCaller();
      const res = await caller.auth.checkEmail({ email: "fresh@test.local" });
      expect(res.available).toBe(true);
    });

    it("returns available=false for a registered email", async () => {
      await makeUser(testDb.client, { email: "taken@test.local" });
      const caller = await makeAppCaller();
      const res = await caller.auth.checkEmail({ email: "taken@test.local" });
      expect(res.available).toBe(false);
    });

    it("rejects malformed emails", async () => {
      const caller = await makeAppCaller();
      await expect(
        caller.auth.checkEmail({ email: "not-an-email" }),
      ).rejects.toThrow();
    });
  });

  describe("devLogin", () => {
    it("creates a fresh user and mints an api token when auth.dev.allow-dev-login is on", async () => {
      const caller = await makeAppCaller();
      const res = await caller.auth.devLogin({
        email: "newbie@test.local",
        tokenName: "ci",
      });
      expect(res.apiToken).toMatch(/^[a-f0-9]{64}$/);
      expect(res.user.email).toBe("newbie@test.local");

      // User and token actually persisted.
      const userRow = await testDb.client.user.findUniqueOrThrow({
        where: { email: "newbie@test.local" },
      });
      const tokens = await testDb.client.apiToken.findMany({
        where: { userId: userRow.id },
      });
      expect(tokens).toHaveLength(1);
      expect(tokens[0]?.token).toBe(res.apiToken);
      expect(tokens[0]?.name).toBe("ci");
    });

    it("re-uses an existing user instead of duplicating", async () => {
      const existing = await makeUser(testDb.client, {
        email: "returning@test.local",
      });
      const caller = await makeAppCaller();
      const res = await caller.auth.devLogin({
        email: "returning@test.local",
      });
      expect(res.user.id).toBe(existing.id);

      const userCount = await testDb.client.user.count({
        where: { email: "returning@test.local" },
      });
      expect(userCount).toBe(1);
    });

    it("rejects with FORBIDDEN when dev login is disabled", async () => {
      setConfig("auth.dev.allow-dev-login", false);
      const caller = await makeAppCaller();
      await expect(
        caller.auth.devLogin({ email: "blocked@test.local" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
    });

    it("stores the deviceCode when provided", async () => {
      const caller = await makeAppCaller();
      await caller.auth.devLogin({
        email: "device@test.local",
        deviceCode: "test-device-123",
      });
      const token = await testDb.client.apiToken.findFirstOrThrow({
        where: { deviceCode: "test-device-123" },
      });
      expect(token.deviceCode).toBe("test-device-123");
    });
  });
});
