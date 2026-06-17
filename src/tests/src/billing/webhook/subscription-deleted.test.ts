// `customer.subscription.deleted` — Stripe canceled the subscription
// (either at our request or because of unrecoverable payment failure).
// Mark the org CANCELED, clear stripeSubscriptionId, and warn admins.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { setupWebhookEnv, getSendEmailMock } from "../harness/webhook";
import { buildSignedWebhookRequest } from "../harness/sign";
import { makeOrg, makeStripeEvent, makeUser } from "../harness/fixtures";

describe("webhook: customer.subscription.deleted", () => {
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

  it("flips the matching org to CANCELED, sets canceledAt, and clears stripeSubscriptionId", async () => {
    const org = await makeOrg(env.testDb.client, {
      stripeSubscriptionId: "sub_to_delete",
      status: "ACTIVE",
    });

    const event = makeStripeEvent("customer.subscription.deleted", {
      id: "sub_to_delete",
    });
    const { request } = buildSignedWebhookRequest(event);
    await env.POST(request);

    const updated = await env.testDb.client.org.findUniqueOrThrow({
      where: { id: org.id },
    });
    expect(updated.subscriptionStatus).toBe("CANCELED");
    expect(updated.canceledAt).not.toBeNull();
    expect(updated.stripeSubscriptionId).toBeNull();
  });

  it("queues a deletion-warning email to each admin/billing user", async () => {
    const org = await makeOrg(env.testDb.client, {
      stripeSubscriptionId: "sub_warn_admins",
      status: "ACTIVE",
    });
    const a1 = await makeUser(env.testDb.client, {
      email: "a1@warn.local",
    });
    const a2 = await makeUser(env.testDb.client, {
      email: "a2@warn.local",
    });
    const m = await makeUser(env.testDb.client, {
      email: "member@warn.local",
    });
    await env.testDb.client.orgUser.createMany({
      data: [
        { orgId: org.id, userId: a1.id, role: "ADMIN" },
        { orgId: org.id, userId: a2.id, role: "BILLING" },
        { orgId: org.id, userId: m.id, role: "MEMBER" },
      ],
    });

    const event = makeStripeEvent("customer.subscription.deleted", {
      id: "sub_warn_admins",
    });
    const { request } = buildSignedWebhookRequest(event);
    await env.POST(request);

    const sendEmailMock = getSendEmailMock();
    const recipients = sendEmailMock.mock.calls.map((c) => c[0].to).sort();
    expect(recipients).toEqual(["a1@warn.local", "a2@warn.local"]);
  });

  it("ignores deletions for subscriptions we don't know", async () => {
    const event = makeStripeEvent("customer.subscription.deleted", {
      id: "sub_unknown_delete",
    });
    const { request } = buildSignedWebhookRequest(event);
    const res = await env.POST(request);
    expect(res.status).toBe(200);

    const orgs = await env.testDb.client.org.findMany();
    expect(orgs).toHaveLength(0);
  });
});
