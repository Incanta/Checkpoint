// Tests for trial.ts — starting a free trial and reaping expired trials in
// the daily check.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { startTrial, checkTrialExpiry } from "~/server/billing/trial";
import { createTestDb, type TestDb } from "../harness/db";
import {
  enableLicenseManager,
  setSimulatedDay,
  clearSimulatedDay,
} from "../harness/gates";
import { makeOrg, makeUser } from "../harness/fixtures";

describe("trial", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 120_000);

  afterAll(async () => {
    await testDb.teardown();
  });

  beforeEach(async () => {
    await testDb.reset();
    enableLicenseManager();
  });

  describe("startTrial", () => {
    it("sets org to TRIAL with trialEndsAt 30 days out and marks user.trialUsed", async () => {
      const user = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, { status: "ACTIVE" });

      // Pin "now" so the assertion on trialEndsAt is deterministic.
      const today = new Date("2026-06-15T12:00:00Z");
      setSimulatedDay(today);

      try {
        const result = await startTrial(org.id, user.id, testDb.client, "PRO");

        expect(result.success).toBe(true);
        expect(result.trialEndsAt).not.toBeNull();

        const orgRow = await testDb.client.org.findUniqueOrThrow({
          where: { id: org.id },
        });
        expect(orgRow.subscriptionStatus).toBe("TRIAL");
        expect(orgRow.subscriptionTier).toBe("PRO");
        expect(orgRow.trialEndsAt).not.toBeNull();
        // 30 days from June 15 = July 15
        expect(orgRow.trialEndsAt?.getMonth()).toBe(6); // July (0-indexed)
        expect(orgRow.trialEndsAt?.getDate()).toBe(15);

        const userRow = await testDb.client.user.findUniqueOrThrow({
          where: { id: user.id },
        });
        expect(userRow.trialUsed).toBe(true);
      } finally {
        clearSimulatedDay();
      }
    });

    it("rejects when user.trialUsed is already true", async () => {
      const user = await makeUser(testDb.client, { trialUsed: true });
      const org = await makeOrg(testDb.client, { status: "ACTIVE" });

      const result = await startTrial(org.id, user.id, testDb.client);

      expect(result.success).toBe(false);
      expect(result.trialEndsAt).toBeNull();
      expect(result.error).toMatch(/already used/i);

      // Org should be untouched.
      const orgRow = await testDb.client.org.findUniqueOrThrow({
        where: { id: org.id },
      });
      expect(orgRow.subscriptionStatus).toBe("ACTIVE");
    });

    it("defaults to BASIC tier when no tier specified", async () => {
      const user = await makeUser(testDb.client);
      const org = await makeOrg(testDb.client, { tier: "STUDIO" });

      await startTrial(org.id, user.id, testDb.client);

      const orgRow = await testDb.client.org.findUniqueOrThrow({
        where: { id: org.id },
      });
      expect(orgRow.subscriptionTier).toBe("BASIC");
    });
  });

  describe("checkTrialExpiry", () => {
    it("leaves active trials in place", async () => {
      const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
      const org = await makeOrg(testDb.client, {
        status: "TRIAL",
        trialEndsAt: future,
      });

      await checkTrialExpiry(testDb.client);

      const row = await testDb.client.org.findUniqueOrThrow({
        where: { id: org.id },
      });
      expect(row.subscriptionStatus).toBe("TRIAL");
    });

    it("transitions expired un-canceled trials to ACTIVE", async () => {
      const past = new Date(Date.now() - 60 * 1000);
      const org = await makeOrg(testDb.client, {
        status: "TRIAL",
        trialEndsAt: past,
      });

      await checkTrialExpiry(testDb.client);

      const row = await testDb.client.org.findUniqueOrThrow({
        where: { id: org.id },
      });
      expect(row.subscriptionStatus).toBe("ACTIVE");
    });

    it("expired canceled trials transition to SUSPENDED with delinquentSince set", async () => {
      const past = new Date(Date.now() - 60 * 1000);
      const org = await testDb.client.org.create({
        data: {
          name: `canceled-trial-${Date.now()}`,
          subscriptionTier: "BASIC",
          subscriptionStatus: "TRIAL",
          trialEndsAt: past,
          canceledAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
          billingCycleAnchor: 1,
        },
      });

      await checkTrialExpiry(testDb.client);

      const row = await testDb.client.org.findUniqueOrThrow({
        where: { id: org.id },
      });
      expect(row.subscriptionStatus).toBe("SUSPENDED");
      expect(row.suspendedAt).not.toBeNull();
      expect(row.delinquentSince).not.toBeNull();
    });

    it("skips soft-deleted orgs", async () => {
      const past = new Date(Date.now() - 60 * 1000);
      const org = await testDb.client.org.create({
        data: {
          name: `deleted-trial-${Date.now()}`,
          subscriptionTier: "BASIC",
          subscriptionStatus: "TRIAL",
          trialEndsAt: past,
          billingCycleAnchor: 1,
          deletedAt: new Date(),
        },
      });

      await checkTrialExpiry(testDb.client);

      const row = await testDb.client.org.findUniqueOrThrow({
        where: { id: org.id },
      });
      expect(row.subscriptionStatus).toBe("TRIAL");
    });
  });
});
