// Tests for meter-reporting.ts — counting active write/read users (cloud vs
// self-hosted) and reporting them plus storage / minimum-due to Stripe via
// `stripe.billing.meterEvents.create`.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import {
  getOrgUserMeters,
  reportOrgMeters,
} from "~/server/billing/meter-reporting";
import { createTestDb, type TestDb } from "../harness/db";
import {
  enableLicenseManager,
  disableLicenseManager,
  setStripeClient,
  setSimulatedDay,
  clearSimulatedDay,
} from "../harness/gates";
import { createStripeMock, type MockStripe } from "../harness/stripe-mock";
import { makeOrg } from "../harness/fixtures";
import { setConfig } from "../harness/config";

describe("meter-reporting", () => {
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
    // Pin time so getBillingPeriod is deterministic.
    setSimulatedDay(new Date("2026-06-15T12:00:00Z"));
  });

  describe("getOrgUserMeters (cloud)", () => {
    it("counts users with writeCount>0 as writers and read-only users separately", async () => {
      const org = await makeOrg(testDb.client);
      // Three users active for billing period June 2026 (anchor=1 → calendar month).
      const u1 = await testDb.client.user.create({
        data: { email: "u1@t.local" },
      });
      const u2 = await testDb.client.user.create({
        data: { email: "u2@t.local" },
      });
      const u3 = await testDb.client.user.create({
        data: { email: "u3@t.local" },
      });
      await testDb.client.orgUserActivity.createMany({
        data: [
          {
            orgId: org.id,
            userId: u1.id,
            year: 2026,
            month: 6,
            writeCount: 5,
            readCount: 10,
          },
          {
            orgId: org.id,
            userId: u2.id,
            year: 2026,
            month: 6,
            writeCount: 0,
            readCount: 7,
          },
          {
            orgId: org.id,
            userId: u3.id,
            year: 2026,
            month: 6,
            writeCount: 1,
            readCount: 0,
          },
        ],
      });

      const result = await getOrgUserMeters(
        {
          id: org.id,
          selfHosted: false,
          billingCycleAnchor: 1,
          canceledAt: null,
          stripeCustomerId: "cus_test",
          subscriptionStatus: "ACTIVE",
          subscriptionTier: "PRO",
        },
        testDb.client,
      );

      expect(result).toEqual({ writeUsers: 2, readUsers: 1 });
    });

    it("returns null when Stripe is disabled", async () => {
      disableLicenseManager();
      const result = await getOrgUserMeters(
        {
          id: "x",
          selfHosted: false,
          billingCycleAnchor: 1,
          canceledAt: null,
          stripeCustomerId: "cus_x",
          subscriptionStatus: "ACTIVE",
          subscriptionTier: "PRO",
        },
        testDb.client,
      );
      expect(result).toBeNull();
    });

    it("returns null when org has no stripeCustomerId", async () => {
      const org = await makeOrg(testDb.client);
      const result = await getOrgUserMeters(
        {
          id: org.id,
          selfHosted: false,
          billingCycleAnchor: 1,
          canceledAt: null,
          stripeCustomerId: null,
          subscriptionStatus: "ACTIVE",
          subscriptionTier: "PRO",
        },
        testDb.client,
      );
      expect(result).toBeNull();
    });

    it("zeroes counts for a TRIAL+canceled org (no charges during the wind-down)", async () => {
      const org = await makeOrg(testDb.client);
      const user = await testDb.client.user.create({
        data: { email: "u@t.local" },
      });
      await testDb.client.orgUserActivity.create({
        data: {
          orgId: org.id,
          userId: user.id,
          year: 2026,
          month: 6,
          writeCount: 5,
          readCount: 5,
        },
      });

      const result = await getOrgUserMeters(
        {
          id: org.id,
          selfHosted: false,
          billingCycleAnchor: 1,
          canceledAt: new Date(),
          stripeCustomerId: "cus_x",
          subscriptionStatus: "TRIAL",
          subscriptionTier: "PRO",
        },
        testDb.client,
      );
      expect(result).toEqual({ writeUsers: 0, readUsers: 0 });
    });
  });

  describe("getOrgUserMeters (self-hosted)", () => {
    it("reads from LicenseUsageReport for the matching billing period", async () => {
      const org = await makeOrg(testDb.client, { selfHosted: true });
      const license = await testDb.client.license.create({
        data: {
          orgId: org.id,
          key: "lic_test",
          secretHash: "h",
          tier: "PRO",
          active: true,
        },
      });
      await testDb.client.licenseUsageReport.create({
        data: {
          licenseId: license.id,
          year: 2026,
          month: 6,
          awuCount: 4,
          aruCount: 9,
        },
      });

      const result = await getOrgUserMeters(
        {
          id: org.id,
          selfHosted: true,
          billingCycleAnchor: 1,
          canceledAt: null,
          stripeCustomerId: "cus_sh",
          subscriptionStatus: "ACTIVE",
          subscriptionTier: "PRO",
        },
        testDb.client,
      );

      expect(result).toEqual({ writeUsers: 4, readUsers: 9 });
    });

    it("returns null when self-hosted org has no usage report yet", async () => {
      const org = await makeOrg(testDb.client, { selfHosted: true });
      await testDb.client.license.create({
        data: {
          orgId: org.id,
          key: "lic_noreport",
          secretHash: "h",
          tier: "PRO",
          active: true,
        },
      });

      const result = await getOrgUserMeters(
        {
          id: org.id,
          selfHosted: true,
          billingCycleAnchor: 1,
          canceledAt: null,
          stripeCustomerId: "cus_sh",
          subscriptionStatus: "ACTIVE",
          subscriptionTier: "PRO",
        },
        testDb.client,
      );
      expect(result).toBeNull();
    });
  });

  describe("reportOrgMeters", () => {
    it("posts the four required meter events for a cloud org (write, read, storage, minimum-due)", async () => {
      setConfig("stripe.minimum-invoice.enabled", true);
      setConfig("stripe.minimum-invoice.cents", 500);

      const org = await makeOrg(testDb.client, {
        tier: "PRO",
        status: "ACTIVE",
        stripeCustomerId: "cus_report",
      });
      stripe.customers.retrieve.mockResolvedValue({
        id: "cus_report",
        deleted: false,
        balance: 0,
      });

      await reportOrgMeters(org.id, "cus_report", 0, 2, testDb.client);

      const eventNames = stripe.billing.meterEvents.create.mock.calls.map(
        (c) => c[0].event_name,
      );
      expect(eventNames).toContain("checkpoint_write_users");
      expect(eventNames).toContain("checkpoint_read_users");
      expect(eventNames).toContain("checkpoint_storage_buckets");
      expect(eventNames).toContain("checkpoint_minimum_due");
    });

    it("skips the storage meter when buckets=0", async () => {
      const org = await makeOrg(testDb.client, {
        tier: "BASIC",
        stripeCustomerId: "cus_nostorage",
      });
      await reportOrgMeters(org.id, "cus_nostorage", 0, 0, testDb.client);
      const eventNames = stripe.billing.meterEvents.create.mock.calls.map(
        (c) => c[0].event_name,
      );
      expect(eventNames).not.toContain("checkpoint_storage_buckets");
    });

    it("skips entirely when Stripe is disabled", async () => {
      disableLicenseManager();
      const org = await makeOrg(testDb.client, {
        stripeCustomerId: "cus_off",
      });
      await reportOrgMeters(org.id, "cus_off", 0, 5, testDb.client);
      expect(stripe.billing.meterEvents.create).not.toHaveBeenCalled();
    });

    it("zeroes the minimum-due meter for a canceled subscription", async () => {
      setConfig("stripe.minimum-invoice.enabled", true);
      setConfig("stripe.minimum-invoice.cents", 1000);

      const org = await makeOrg(testDb.client, {
        tier: "BASIC",
        status: "CANCELED",
        stripeCustomerId: "cus_canceled",
      });
      await testDb.client.org.update({
        where: { id: org.id },
        data: { canceledAt: new Date() },
      });

      await reportOrgMeters(org.id, "cus_canceled", 0, 0, testDb.client);

      const minDue = stripe.billing.meterEvents.create.mock.calls.find(
        (c) => c[0].event_name === "checkpoint_minimum_due",
      );
      expect(minDue?.[0].payload.value).toBe("0");
    });
  });

  afterAll(() => {
    clearSimulatedDay();
  });
});
