// `customer.subscription.updated` — sync trial end / billing cycle anchor
// from Stripe and lift an org out of PAST_DUE/SUSPENDED when the
// subscription is active again.

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

describe("webhook: customer.subscription.updated", () => {
  const env = setupWebhookEnv();

  beforeAll(async () => {
    await env.start();
  }, 120_000);

  afterAll(async () => {
    await env.stop();
  });

  beforeEach(async () => {
    await env.reset();
  });

  it("syncs trial_end into trialEndsAt", async () => {
    const org = await makeOrg(env.testDb.client, {
      stripeSubscriptionId: "sub_trial_sync",
      status: "TRIAL",
    });
    // 2026-07-01 UTC
    const trialEndEpoch = Math.floor(
      new Date("2026-07-01T00:00:00Z").getTime() / 1000,
    );

    const event = makeStripeEvent("customer.subscription.updated", {
      id: "sub_trial_sync",
      status: "trialing",
      trial_end: trialEndEpoch,
    });
    const { request } = buildSignedWebhookRequest(event);
    await env.POST(request);

    const updated = await env.testDb.client.org.findUniqueOrThrow({
      where: { id: org.id },
    });
    expect(updated.trialEndsAt?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("syncs billing_cycle_anchor's UTC day into billingCycleAnchor", async () => {
    const org = await makeOrg(env.testDb.client, {
      stripeSubscriptionId: "sub_anchor",
      billingCycleAnchor: 1,
    });
    // Aug 15, 2026 UTC
    const anchorEpoch = Math.floor(
      new Date("2026-08-15T00:00:00Z").getTime() / 1000,
    );

    const event = makeStripeEvent("customer.subscription.updated", {
      id: "sub_anchor",
      status: "active",
      billing_cycle_anchor: anchorEpoch,
    });
    const { request } = buildSignedWebhookRequest(event);
    await env.POST(request);

    const updated = await env.testDb.client.org.findUniqueOrThrow({
      where: { id: org.id },
    });
    expect(updated.billingCycleAnchor).toBe(15);
  });

  it("restores PAST_DUE → ACTIVE when Stripe reports the sub as active again", async () => {
    const org = await makeOrg(env.testDb.client, {
      stripeSubscriptionId: "sub_recover",
      status: "PAST_DUE",
      delinquentSince: new Date(),
    });

    const event = makeStripeEvent("customer.subscription.updated", {
      id: "sub_recover",
      status: "active",
    });
    const { request } = buildSignedWebhookRequest(event);
    await env.POST(request);

    const updated = await env.testDb.client.org.findUniqueOrThrow({
      where: { id: org.id },
    });
    expect(updated.subscriptionStatus).toBe("ACTIVE");
    expect(updated.delinquentSince).toBeNull();
  });

  it("does not touch an ACTIVE org with no relevant updates", async () => {
    const org = await makeOrg(env.testDb.client, {
      stripeSubscriptionId: "sub_noop",
      status: "ACTIVE",
    });

    const event = makeStripeEvent("customer.subscription.updated", {
      id: "sub_noop",
      status: "active",
    });
    const { request } = buildSignedWebhookRequest(event);
    const res = await env.POST(request);
    expect(res.status).toBe(200);

    const after = await env.testDb.client.org.findUniqueOrThrow({
      where: { id: org.id },
    });
    expect(after.subscriptionStatus).toBe("ACTIVE");
  });

  it("ignores subscriptions we don't know", async () => {
    const event = makeStripeEvent("customer.subscription.updated", {
      id: "sub_ghost",
      status: "active",
    });
    const { request } = buildSignedWebhookRequest(event);
    const res = await env.POST(request);
    expect(res.status).toBe(200);
  });
});
