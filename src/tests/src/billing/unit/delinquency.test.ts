// Tests for delinquency.ts — markDelinquent, the daily checkDelinquency
// transitions (PAST_DUE → SUSPENDED → DELETED), resumeSubscription, and
// cancelSubscription.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import {
  markDelinquent,
  checkDelinquency,
  resumeSubscription,
  cancelSubscription,
} from "~/server/billing/delinquency";
import { createTestDb, type TestDb } from "../harness/db";
import {
  enableLicenseManager,
  setStripeClient,
  setSimulatedDay,
  clearSimulatedDay,
} from "../harness/gates";
import { createStripeMock, type MockStripe } from "../harness/stripe-mock";
import { makeOrg } from "../harness/fixtures";

describe("delinquency", () => {
  let testDb: TestDb;
  let stripe: MockStripe;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 120_000);

  afterAll(async () => {
    await testDb.teardown();
  });

  beforeEach(async () => {
    await testDb.reset();
    enableLicenseManager();
    stripe = createStripeMock();
    setStripeClient(stripe as never);
  });

  describe("markDelinquent", () => {
    it("sets status=PAST_DUE and delinquentSince on first call", async () => {
      const org = await makeOrg(testDb.client, { status: "ACTIVE" });
      await markDelinquent(org.id, testDb.client);

      const row = await testDb.client.org.findUniqueOrThrow({
        where: { id: org.id },
      });
      expect(row.subscriptionStatus).toBe("PAST_DUE");
      expect(row.delinquentSince).not.toBeNull();
    });

    it("does not overwrite an existing delinquentSince", async () => {
      const first = new Date("2026-06-01T00:00:00Z");
      const org = await makeOrg(testDb.client, {
        status: "PAST_DUE",
        delinquentSince: first,
      });
      await markDelinquent(org.id, testDb.client);

      const row = await testDb.client.org.findUniqueOrThrow({
        where: { id: org.id },
      });
      expect(row.delinquentSince?.getTime()).toBe(first.getTime());
    });
  });

  describe("checkDelinquency", () => {
    it("PAST_DUE → SUSPENDED after suspendAfterDays", async () => {
      // Defaults: suspendAfterDays=5, deleteAfterDays=14
      const longAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const org = await makeOrg(testDb.client, {
        status: "PAST_DUE",
        delinquentSince: longAgo,
      });

      await checkDelinquency(testDb.client);

      const row = await testDb.client.org.findUniqueOrThrow({
        where: { id: org.id },
      });
      expect(row.subscriptionStatus).toBe("SUSPENDED");
      expect(row.suspendedAt).not.toBeNull();
    });

    it("PAST_DUE within suspendAfterDays stays PAST_DUE", async () => {
      const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const org = await makeOrg(testDb.client, {
        status: "PAST_DUE",
        delinquentSince: recent,
      });

      await checkDelinquency(testDb.client);

      const row = await testDb.client.org.findUniqueOrThrow({
        where: { id: org.id },
      });
      expect(row.subscriptionStatus).toBe("PAST_DUE");
    });

    it("SUSPENDED → DELETED after deleteAfterDays from delinquentSince", async () => {
      const wayLongAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
      const org = await makeOrg(testDb.client, {
        status: "SUSPENDED",
        delinquentSince: wayLongAgo,
        suspendedAt: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000),
      });

      await checkDelinquency(testDb.client);

      const row = await testDb.client.org.findUniqueOrThrow({
        where: { id: org.id },
      });
      expect(row.subscriptionStatus).toBe("DELETED");
    });

    it("CANCELED → DELETED after deleteAfterDays from canceledAt", async () => {
      const org = await testDb.client.org.create({
        data: {
          name: `canceled-${Date.now()}`,
          subscriptionTier: "PRO",
          subscriptionStatus: "CANCELED",
          canceledAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
          billingCycleAnchor: 1,
        },
      });

      await checkDelinquency(testDb.client);

      const row = await testDb.client.org.findUniqueOrThrow({
        where: { id: org.id },
      });
      expect(row.subscriptionStatus).toBe("DELETED");
    });
  });

  describe("resumeSubscription", () => {
    it("PAST_DUE → ACTIVE clears delinquency markers and retries open invoices", async () => {
      const org = await makeOrg(testDb.client, {
        status: "PAST_DUE",
        delinquentSince: new Date(Date.now() - 24 * 60 * 60 * 1000),
        stripeCustomerId: "cus_test_resume",
        stripeSubscriptionId: "sub_test_resume",
      });
      stripe.subscriptions.retrieve.mockResolvedValue({
        id: "sub_test_resume",
        cancel_at_period_end: false,
        status: "active",
        items: { data: [] },
      });
      stripe.invoices.list.mockResolvedValue({
        data: [
          { id: "in_open_1", status: "open" },
          { id: "in_open_2", status: "open" },
        ],
      });

      const result = await resumeSubscription(org.id, testDb.client);

      expect(result.success).toBe(true);
      expect(stripe.invoices.pay).toHaveBeenCalledTimes(2);
      expect(stripe.invoices.pay).toHaveBeenCalledWith("in_open_1");
      expect(stripe.invoices.pay).toHaveBeenCalledWith("in_open_2");

      const row = await testDb.client.org.findUniqueOrThrow({
        where: { id: org.id },
      });
      expect(row.subscriptionStatus).toBe("ACTIVE");
      expect(row.delinquentSince).toBeNull();
      expect(row.suspendedAt).toBeNull();
    });

    it("clears Stripe's cancel_at_period_end when set", async () => {
      const org = await makeOrg(testDb.client, {
        status: "PAST_DUE",
        delinquentSince: new Date(Date.now() - 24 * 60 * 60 * 1000),
        stripeSubscriptionId: "sub_pending_cancel",
      });
      stripe.subscriptions.retrieve.mockResolvedValue({
        id: "sub_pending_cancel",
        cancel_at_period_end: true,
        status: "active",
        items: { data: [] },
      });
      stripe.invoices.list.mockResolvedValue({ data: [] });

      await resumeSubscription(org.id, testDb.client);

      expect(stripe.subscriptions.update).toHaveBeenCalledWith(
        "sub_pending_cancel",
        { cancel_at_period_end: false },
      );
    });

    it("rejects orgs not in a resumable state", async () => {
      const org = await makeOrg(testDb.client, { status: "ACTIVE" });
      const result = await resumeSubscription(org.id, testDb.client);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not in a resumable state/i);
    });
  });

  describe("cancelSubscription", () => {
    it("flips ACTIVE → CANCELED and tells Stripe to cancel at period end", async () => {
      const org = await makeOrg(testDb.client, {
        status: "ACTIVE",
        stripeSubscriptionId: "sub_to_cancel",
      });

      const today = new Date("2026-06-15T12:00:00Z");
      setSimulatedDay(today);

      try {
        await cancelSubscription(org.id, testDb.client);

        expect(stripe.subscriptions.update).toHaveBeenCalledWith(
          "sub_to_cancel",
          { cancel_at_period_end: true },
        );
        const row = await testDb.client.org.findUniqueOrThrow({
          where: { id: org.id },
        });
        expect(row.subscriptionStatus).toBe("CANCELED");
        expect(row.canceledAt).not.toBeNull();
      } finally {
        clearSimulatedDay();
      }
    });

    it("keeps TRIAL status when canceling a trial (sets canceledAt only)", async () => {
      const org = await makeOrg(testDb.client, {
        status: "TRIAL",
        stripeSubscriptionId: "sub_trial_cancel",
      });

      await cancelSubscription(org.id, testDb.client);

      const row = await testDb.client.org.findUniqueOrThrow({
        where: { id: org.id },
      });
      expect(row.subscriptionStatus).toBe("TRIAL");
      expect(row.canceledAt).not.toBeNull();
    });

    it("refuses to cancel from SUSPENDED", async () => {
      const org = await makeOrg(testDb.client, { status: "SUSPENDED" });
      await expect(cancelSubscription(org.id, testDb.client)).rejects.toThrow(
        /Cannot cancel/,
      );
    });
  });
});
