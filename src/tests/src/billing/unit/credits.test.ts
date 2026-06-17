// Tests for credits.ts — managing the Stripe Customer Balance and the local
// cache mirror. Two paths exist: Stripe-enabled (the source of truth is
// `stripe.customers.balance`) and Stripe-disabled (we mutate
// `Org.creditBalanceCents` directly).

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import {
  addCredits,
  removeCredits,
  syncCreditBalance,
  getCreditBalance,
} from "~/server/billing/credits";
import { createTestDb, type TestDb } from "../harness/db";
import {
  enableLicenseManager,
  disableLicenseManager,
  setStripeClient,
} from "../harness/gates";
import { createStripeMock, type MockStripe } from "../harness/stripe-mock";
import { makeOrg } from "../harness/fixtures";
import { setConfig } from "../harness/config";

describe("credits", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 120_000);

  afterAll(async () => {
    await testDb.teardown();
  });

  describe("Stripe-disabled (license-manager off)", () => {
    beforeEach(async () => {
      await testDb.reset();
      disableLicenseManager();
    });

    it("addCredits increments creditBalanceCents locally", async () => {
      const org = await makeOrg(testDb.client, { creditBalanceCents: 100 });
      await addCredits(org.id, 250, "test top-up", testDb.client);
      const row = await testDb.client.org.findUniqueOrThrow({
        where: { id: org.id },
      });
      expect(row.creditBalanceCents).toBe(350);
    });

    it("removeCredits decrements creditBalanceCents but clamps to zero", async () => {
      const org = await makeOrg(testDb.client, { creditBalanceCents: 100 });
      await removeCredits(org.id, 300, "test debit", testDb.client);
      const row = await testDb.client.org.findUniqueOrThrow({
        where: { id: org.id },
      });
      expect(row.creditBalanceCents).toBe(0);
    });

    it("addCredits with zero or negative amount is a no-op", async () => {
      const org = await makeOrg(testDb.client, { creditBalanceCents: 100 });
      await addCredits(org.id, 0, "noop", testDb.client);
      await addCredits(org.id, -50, "noop", testDb.client);
      const row = await testDb.client.org.findUniqueOrThrow({
        where: { id: org.id },
      });
      expect(row.creditBalanceCents).toBe(100);
    });
  });

  describe("Stripe-enabled", () => {
    let stripe: MockStripe;

    beforeEach(async () => {
      await testDb.reset();
      enableLicenseManager();
      stripe = createStripeMock();
      setStripeClient(stripe as never);
      // syncCreditBalance only hits Stripe when minimum-invoice is enabled;
      // turn that on so the Stripe path is exercised.
      setConfig("stripe.minimum-invoice.enabled", true);
    });

    it("addCredits posts a negative balance transaction to Stripe", async () => {
      const org = await makeOrg(testDb.client, {
        stripeCustomerId: "cus_test_addcredits",
      });
      stripe.customers.retrieve.mockResolvedValue({
        id: "cus_test_addcredits",
        deleted: false,
        balance: -500, // 500c of credit
      });

      await addCredits(org.id, 500, "top-up", testDb.client);

      expect(stripe.customers.createBalanceTransaction).toHaveBeenCalledWith(
        "cus_test_addcredits",
        { amount: -500, currency: "usd", description: "top-up" },
      );
      const row = await testDb.client.org.findUniqueOrThrow({
        where: { id: org.id },
      });
      // Cache pulled from the mocked Stripe customer.balance.
      expect(row.creditBalanceCents).toBe(500);
    });

    it("removeCredits posts a positive balance transaction to Stripe", async () => {
      const org = await makeOrg(testDb.client, {
        stripeCustomerId: "cus_test_removecredits",
        creditBalanceCents: 500,
      });
      stripe.customers.retrieve.mockResolvedValue({
        id: "cus_test_removecredits",
        deleted: false,
        balance: -200, // 200c of credit left
      });

      await removeCredits(org.id, 300, "applied", testDb.client);

      expect(stripe.customers.createBalanceTransaction).toHaveBeenCalledWith(
        "cus_test_removecredits",
        { amount: 300, currency: "usd", description: "applied" },
      );
      const row = await testDb.client.org.findUniqueOrThrow({
        where: { id: org.id },
      });
      expect(row.creditBalanceCents).toBe(200);
    });

    it("addCredits skips Stripe when org has no stripeCustomerId", async () => {
      const org = await makeOrg(testDb.client, {
        stripeCustomerId: null,
      });
      await addCredits(org.id, 100, "no-op", testDb.client);
      expect(stripe.customers.createBalanceTransaction).not.toHaveBeenCalled();
    });

    it("syncCreditBalance writes |balance| to the cache and ignores positive balances", async () => {
      const org = await makeOrg(testDb.client, {
        stripeCustomerId: "cus_sync",
      });
      stripe.customers.retrieve.mockResolvedValue({
        id: "cus_sync",
        deleted: false,
        balance: 750, // positive = debt; credit display should be 0
      });
      const balance = await syncCreditBalance(org.id, "cus_sync", testDb.client);
      expect(balance).toBe(0);
      const row = await testDb.client.org.findUniqueOrThrow({
        where: { id: org.id },
      });
      expect(row.creditBalanceCents).toBe(0);
    });

    it("getCreditBalance returns 0 for deleted Stripe customers", async () => {
      const org = await makeOrg(testDb.client, {
        stripeCustomerId: "cus_deleted",
        creditBalanceCents: 999,
      });
      stripe.customers.retrieve.mockResolvedValue({
        id: "cus_deleted",
        deleted: true,
      });
      const balance = await getCreditBalance(org.id, testDb.client);
      expect(balance).toBe(0);
    });
  });
});
