// `checkout.session.completed` is fired by Stripe when a customer finishes
// the hosted Checkout flow. The handler creates a new org (or reactivates
// one for the resubscribe path), attaches the user as ADMIN, and starts a
// trial if requested.

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
import { makeStripeEvent, makeUser } from "../harness/fixtures";

function checkoutSession(opts: {
  customer?: string;
  subscription?: string;
  metadata?: Record<string, string>;
}): Record<string, unknown> {
  return {
    id: `cs_test_${Math.random().toString(36).slice(2)}`,
    object: "checkout.session",
    customer: opts.customer ?? "cus_test_session",
    subscription: opts.subscription ?? "sub_test_session",
    metadata: opts.metadata ?? {},
    payment_status: "paid",
  };
}

describe("webhook: checkout.session.completed", () => {
  const env = setupWebhookEnv();

  beforeAll(async () => {
    await env.start();
  }, 120_000);

  afterAll(async () => {
    await env.stop();
  });

  beforeEach(async () => {
    await env.reset();
    env.stripe.subscriptions.retrieve.mockResolvedValue({
      id: "sub_test_session",
      status: "active",
      billing_cycle_anchor: null,
      items: { data: [] },
    } as never);
  });

  it("creates an ACTIVE org with admin user when useTrial is not set", async () => {
    const user = await makeUser(env.testDb.client);

    const event = makeStripeEvent(
      "checkout.session.completed",
      checkoutSession({
        customer: "cus_new",
        subscription: "sub_new",
        metadata: {
          orgName: "Acme Corp",
          userId: user.id,
          tier: "PRO",
        },
      }),
    );

    const { request } = buildSignedWebhookRequest(event);
    const res = await env.POST(request);
    expect(res.status).toBe(200);

    const org = await env.testDb.client.org.findFirstOrThrow({
      where: { name: "Acme Corp" },
    });
    expect(org.subscriptionStatus).toBe("ACTIVE");
    expect(org.subscriptionTier).toBe("PRO");
    expect(org.stripeCustomerId).toBe("cus_new");
    expect(org.stripeSubscriptionId).toBe("sub_new");

    const orgUser = await env.testDb.client.orgUser.findFirstOrThrow({
      where: { orgId: org.id, userId: user.id },
    });
    expect(orgUser.role).toBe("ADMIN");
  });

  it("starts a trial when useTrial=true and marks user.trialUsed", async () => {
    const user = await makeUser(env.testDb.client);

    const event = makeStripeEvent(
      "checkout.session.completed",
      checkoutSession({
        metadata: {
          orgName: "Trial Org",
          userId: user.id,
          tier: "BASIC",
          useTrial: "true",
        },
      }),
    );

    const { request } = buildSignedWebhookRequest(event);
    await env.POST(request);

    const org = await env.testDb.client.org.findFirstOrThrow({
      where: { name: "Trial Org" },
    });
    expect(org.subscriptionStatus).toBe("TRIAL");
    expect(org.trialEndsAt).not.toBeNull();

    const userRow = await env.testDb.client.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(userRow.trialUsed).toBe(true);
  });

  it("silently ignores sessions missing orgName/userId metadata", async () => {
    const event = makeStripeEvent(
      "checkout.session.completed",
      checkoutSession({ metadata: {} }),
    );
    const { request } = buildSignedWebhookRequest(event);
    const res = await env.POST(request);
    expect(res.status).toBe(200);

    const orgs = await env.testDb.client.org.findMany();
    expect(orgs).toHaveLength(0);
  });

  it("resubscribe: reactivates an existing CANCELED org instead of creating one", async () => {
    const user = await makeUser(env.testDb.client);
    const orgRow = await env.testDb.client.org.create({
      data: {
        name: "Returning Co",
        subscriptionTier: "BASIC",
        subscriptionStatus: "CANCELED",
        canceledAt: new Date(),
        billingCycleAnchor: 1,
      },
    });

    const event = makeStripeEvent(
      "checkout.session.completed",
      checkoutSession({
        customer: "cus_resub",
        subscription: "sub_resub",
        metadata: {
          existingOrgId: orgRow.id,
          userId: user.id,
          tier: "PRO",
        },
      }),
    );

    const { request } = buildSignedWebhookRequest(event);
    await env.POST(request);

    const updated = await env.testDb.client.org.findUniqueOrThrow({
      where: { id: orgRow.id },
    });
    expect(updated.subscriptionStatus).toBe("ACTIVE");
    expect(updated.subscriptionTier).toBe("PRO");
    expect(updated.stripeCustomerId).toBe("cus_resub");
    expect(updated.canceledAt).toBeNull();

    // Should not have created a duplicate org with the same name.
    const orgs = await env.testDb.client.org.findMany({
      where: { name: "Returning Co" },
    });
    expect(orgs).toHaveLength(1);
  });
});
