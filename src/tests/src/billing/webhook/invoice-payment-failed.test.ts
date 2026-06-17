// `invoice.payment_failed` — flip the local invoice to FAILED, mark the
// org PAST_DUE via `markDelinquent`, and queue admin notification emails.

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
import { makeOrg, makeInvoice, makeStripeEvent, makeUser } from "../harness/fixtures";

describe("webhook: invoice.payment_failed", () => {
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

  it("flips the local invoice to FAILED and the org to PAST_DUE", async () => {
    const org = await makeOrg(env.testDb.client, {
      status: "ACTIVE",
      stripeCustomerId: "cus_failed_pay",
    });
    const inv = await makeInvoice(env.testDb.client, org.id, {
      stripeInvoiceId: "in_failed_pay",
      status: "ISSUED",
    });

    const event = makeStripeEvent("invoice.payment_failed", {
      id: "in_failed_pay",
      customer: "cus_failed_pay",
      amount_due: 1500,
    });
    const { request } = buildSignedWebhookRequest(event);
    await env.POST(request);

    const updatedInv = await env.testDb.client.invoice.findUniqueOrThrow({
      where: { id: inv.id },
    });
    expect(updatedInv.status).toBe("FAILED");
    expect(updatedInv.failedAt).not.toBeNull();

    const orgRow = await env.testDb.client.org.findUniqueOrThrow({
      where: { id: org.id },
    });
    expect(orgRow.subscriptionStatus).toBe("PAST_DUE");
    expect(orgRow.delinquentSince).not.toBeNull();
  });

  it("queues a payment-failed email to each ADMIN and BILLING user", async () => {
    const org = await makeOrg(env.testDb.client, {
      status: "ACTIVE",
      stripeCustomerId: "cus_emails",
    });
    const admin = await makeUser(env.testDb.client, {
      email: "admin@t.local",
    });
    const billing = await makeUser(env.testDb.client, {
      email: "billing@t.local",
    });
    const member = await makeUser(env.testDb.client, {
      email: "member@t.local",
    });
    await env.testDb.client.orgUser.createMany({
      data: [
        { orgId: org.id, userId: admin.id, role: "ADMIN" },
        { orgId: org.id, userId: billing.id, role: "BILLING" },
        { orgId: org.id, userId: member.id, role: "MEMBER" },
      ],
    });

    const event = makeStripeEvent("invoice.payment_failed", {
      id: "in_email_blast",
      customer: "cus_emails",
      amount_due: 999,
    });
    const { request } = buildSignedWebhookRequest(event);
    await env.POST(request);

    const sendEmailMock = getSendEmailMock();
    const recipients = sendEmailMock.mock.calls.map((c) => c[0].to);
    expect(recipients).toContain("admin@t.local");
    expect(recipients).toContain("billing@t.local");
    expect(recipients).not.toContain("member@t.local");
  });

  it("does not overwrite an existing delinquentSince", async () => {
    const original = new Date("2026-06-01T00:00:00Z");
    const org = await makeOrg(env.testDb.client, {
      status: "PAST_DUE",
      stripeCustomerId: "cus_already_pastdue",
      delinquentSince: original,
    });
    await makeInvoice(env.testDb.client, org.id, {
      stripeInvoiceId: "in_repeat_fail",
      status: "ISSUED",
    });

    const event = makeStripeEvent("invoice.payment_failed", {
      id: "in_repeat_fail",
      customer: "cus_already_pastdue",
      amount_due: 100,
    });
    const { request } = buildSignedWebhookRequest(event);
    await env.POST(request);

    const orgRow = await env.testDb.client.org.findUniqueOrThrow({
      where: { id: org.id },
    });
    expect(orgRow.delinquentSince?.getTime()).toBe(original.getTime());
  });

  it("silently ignores events for unknown customers", async () => {
    const event = makeStripeEvent("invoice.payment_failed", {
      id: "in_unknown_fail",
      customer: "cus_ghost",
      amount_due: 100,
    });
    const { request } = buildSignedWebhookRequest(event);
    const res = await env.POST(request);
    expect(res.status).toBe(200);
  });
});
