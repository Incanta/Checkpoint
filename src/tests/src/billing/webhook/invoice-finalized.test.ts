// `invoice.finalized` — when Stripe finalizes an invoice it may auto-apply
// customer balance. We sync the balance back into our local cache.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { setupWebhookEnv } from "../harness/webhook";
import { buildSignedWebhookRequest } from "../harness/sign";
import { makeOrg, makeStripeEvent } from "../harness/fixtures";
import { setConfig } from "../harness/config";

describe("webhook: invoice.finalized", () => {
  const env = setupWebhookEnv();

  beforeAll(async () => {
    await env.start();
  }, 120_000);

  afterAll(async () => {
    await env.stop();
  });

  beforeEach(async () => {
    await env.reset();
    setConfig("stripe.minimum-invoice.enabled", true);
  });

  it("syncs the local credit balance cache to |Stripe.customer.balance|", async () => {
    const org = await makeOrg(env.testDb.client, {
      stripeCustomerId: "cus_finalize",
      creditBalanceCents: 0,
    });
    env.stripe.customers.retrieve.mockResolvedValue({
      id: "cus_finalize",
      deleted: false,
      balance: -1200,
    } as never);

    const event = makeStripeEvent("invoice.finalized", {
      id: "in_finalize",
      customer: "cus_finalize",
    });
    const { request } = buildSignedWebhookRequest(event);
    await env.POST(request);

    const updated = await env.testDb.client.org.findUniqueOrThrow({
      where: { id: org.id },
    });
    expect(updated.creditBalanceCents).toBe(1200);
  });

  it("ignores events for customers we don't know", async () => {
    const event = makeStripeEvent("invoice.finalized", {
      id: "in_unknown",
      customer: "cus_unknown_finalize",
    });
    const { request } = buildSignedWebhookRequest(event);
    const res = await env.POST(request);
    expect(res.status).toBe(200);
    // No DB writes — assert nothing leaked.
    const orgs = await env.testDb.client.org.findMany();
    expect(orgs).toHaveLength(0);
  });

  it("no-ops when the invoice has no customer", async () => {
    await makeOrg(env.testDb.client, { stripeCustomerId: "cus_other" });
    const event = makeStripeEvent("invoice.finalized", {
      id: "in_no_customer",
    });
    const { request } = buildSignedWebhookRequest(event);
    const res = await env.POST(request);
    expect(res.status).toBe(200);
    expect(env.stripe.customers.retrieve).not.toHaveBeenCalled();
  });
});
