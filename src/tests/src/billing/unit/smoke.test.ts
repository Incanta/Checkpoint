// Smoke test — confirms the harness wires correctly:
//   - `@incanta/config` is mocked
//   - `server-only` import doesn't throw
//   - The Prisma test DB spins up and can write a row
//
// If this fails, the unit tests will too — fix this first.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "../harness/db";
import { enableLicenseManager, setStripeClient } from "../harness/gates";
import { createStripeMock } from "../harness/stripe-mock";
import { makeOrg, makeUser } from "../harness/fixtures";

describe("billing test harness smoke", () => {
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
    setStripeClient(createStripeMock() as never);
  });

  it("can create a user", async () => {
    const u = await makeUser(testDb.client, { email: "smoke@test.local" });
    expect(u.id).toBeTruthy();
    expect(u.email).toBe("smoke@test.local");
  });

  it("can create an org with billing fields", async () => {
    const o = await makeOrg(testDb.client, {
      tier: "PRO",
      status: "TRIAL",
      stripeCustomerId: "cus_smoke",
    });
    const row = await testDb.client.org.findUniqueOrThrow({ where: { id: o.id } });
    expect(row.subscriptionTier).toBe("PRO");
    expect(row.subscriptionStatus).toBe("TRIAL");
    expect(row.stripeCustomerId).toBe("cus_smoke");
  });

  it("isStripeEnabled returns true when license-manager + stripe.enabled", async () => {
    const { isStripeEnabled } = await import("~/server/stripe/client");
    expect(isStripeEnabled()).toBe(true);
  });
});
