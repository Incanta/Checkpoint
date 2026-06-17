// `invoice.paid` — apply any pending tier change, flip the local invoice to
// PAID, extract minimum-due into credits, and restore an org from PAST_DUE
// to ACTIVE once all invoices are settled.

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
import { makeOrg, makeInvoice, makeStripeEvent } from "../harness/fixtures";
import { setConfig } from "../harness/config";

interface InvoicePayload {
  id: string;
  customer: string;
  subtotal: number;
  amount_due: number;
  total: number;
  period_start: number;
  lines?: {
    data: Array<{
      amount: number;
      pricing?: { price_details?: { price: string } };
    }>;
  };
}

function paidInvoice(p: Partial<InvoicePayload> = {}): InvoicePayload {
  return {
    id: p.id ?? "in_test_paid",
    customer: p.customer ?? "cus_test",
    subtotal: p.subtotal ?? 1000,
    amount_due: p.amount_due ?? 1000,
    total: p.total ?? 1000,
    period_start: p.period_start ?? Math.floor(Date.now() / 1000),
    lines: p.lines,
  };
}

describe("webhook: invoice.paid", () => {
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

  it("marks the matching local invoice PAID", async () => {
    const org = await makeOrg(env.testDb.client, {
      stripeCustomerId: "cus_paid_1",
    });
    const inv = await makeInvoice(env.testDb.client, org.id, {
      stripeInvoiceId: "in_paid_1",
      status: "ISSUED",
    });

    const event = makeStripeEvent(
      "invoice.paid",
      paidInvoice({ id: "in_paid_1", customer: "cus_paid_1" }),
    );
    const { request } = buildSignedWebhookRequest(event);
    await env.POST(request);

    const updated = await env.testDb.client.invoice.findUniqueOrThrow({
      where: { id: inv.id },
    });
    expect(updated.status).toBe("PAID");
    expect(updated.paidAt).not.toBeNull();
  });

  it("records creditAppliedCents as subtotal - amount_due", async () => {
    const org = await makeOrg(env.testDb.client, {
      stripeCustomerId: "cus_credit_applied",
    });
    const inv = await makeInvoice(env.testDb.client, org.id, {
      stripeInvoiceId: "in_credit_applied",
      status: "ISSUED",
    });

    const event = makeStripeEvent(
      "invoice.paid",
      paidInvoice({
        id: "in_credit_applied",
        customer: "cus_credit_applied",
        subtotal: 1000,
        amount_due: 250,
        total: 250,
      }),
    );
    const { request } = buildSignedWebhookRequest(event);
    await env.POST(request);

    const updated = await env.testDb.client.invoice.findUniqueOrThrow({
      where: { id: inv.id },
    });
    expect(updated.creditAppliedCents).toBe(750);
  });

  it("restores a PAST_DUE org to ACTIVE when all invoices are paid", async () => {
    const org = await makeOrg(env.testDb.client, {
      status: "PAST_DUE",
      stripeCustomerId: "cus_recover",
      delinquentSince: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    const inv = await makeInvoice(env.testDb.client, org.id, {
      stripeInvoiceId: "in_only_unpaid",
      status: "ISSUED",
    });

    const event = makeStripeEvent(
      "invoice.paid",
      paidInvoice({ id: "in_only_unpaid", customer: "cus_recover" }),
    );
    const { request } = buildSignedWebhookRequest(event);
    await env.POST(request);

    const orgRow = await env.testDb.client.org.findUniqueOrThrow({
      where: { id: org.id },
    });
    expect(orgRow.subscriptionStatus).toBe("ACTIVE");
    expect(orgRow.delinquentSince).toBeNull();
  });

  it("keeps a PAST_DUE org in PAST_DUE when other invoices remain unpaid", async () => {
    const org = await makeOrg(env.testDb.client, {
      status: "PAST_DUE",
      stripeCustomerId: "cus_still_pastdue",
      delinquentSince: new Date(),
    });
    await makeInvoice(env.testDb.client, org.id, {
      stripeInvoiceId: "in_one",
      status: "ISSUED",
      year: 2026,
      month: 5,
    });
    await makeInvoice(env.testDb.client, org.id, {
      stripeInvoiceId: "in_two_still_unpaid",
      status: "FAILED",
      year: 2026,
      month: 6,
    });

    const event = makeStripeEvent(
      "invoice.paid",
      paidInvoice({ id: "in_one", customer: "cus_still_pastdue" }),
    );
    const { request } = buildSignedWebhookRequest(event);
    await env.POST(request);

    const orgRow = await env.testDb.client.org.findUniqueOrThrow({
      where: { id: org.id },
    });
    expect(orgRow.subscriptionStatus).toBe("PAST_DUE");
  });

  it("applies a scheduled tier change on the next paid invoice", async () => {
    const org = await makeOrg(env.testDb.client, {
      tier: "STUDIO",
      status: "ACTIVE",
      stripeCustomerId: "cus_downgrade",
      stripeSubscriptionId: "sub_downgrade",
      scheduledTier: "BASIC",
      scheduledTierAt: new Date(),
    });
    await makeInvoice(env.testDb.client, org.id, {
      stripeInvoiceId: "in_downgrade",
      status: "ISSUED",
    });
    env.stripe.subscriptions.retrieve.mockResolvedValue({
      id: "sub_downgrade",
      items: { data: [] },
    } as never);

    const event = makeStripeEvent(
      "invoice.paid",
      paidInvoice({ id: "in_downgrade", customer: "cus_downgrade" }),
    );
    const { request } = buildSignedWebhookRequest(event);
    await env.POST(request);

    const orgRow = await env.testDb.client.org.findUniqueOrThrow({
      where: { id: org.id },
    });
    expect(orgRow.subscriptionTier).toBe("BASIC");
    expect(orgRow.scheduledTier).toBeNull();
    expect(orgRow.scheduledTierAt).toBeNull();
  });

  it("extracts minimum-due line items as credits on the org", async () => {
    // The route reads the minimum-due price id from stripe.prices.cloud.minimum-due
    setConfig("stripe.prices.cloud.minimum-due", "price_cloud_minimum_due");
    setConfig("stripe.minimum-invoice.enabled", true);

    const org = await makeOrg(env.testDb.client, {
      stripeCustomerId: "cus_minimum_due",
      status: "ACTIVE",
    });
    await makeInvoice(env.testDb.client, org.id, {
      stripeInvoiceId: "in_min_due",
      status: "ISSUED",
    });
    env.stripe.customers.retrieve.mockResolvedValue({
      id: "cus_minimum_due",
      deleted: false,
      balance: -300,
    } as never);

    const event = makeStripeEvent(
      "invoice.paid",
      paidInvoice({
        id: "in_min_due",
        customer: "cus_minimum_due",
        lines: {
          data: [
            { amount: 1000, pricing: { price_details: { price: "price_other" } } },
            {
              amount: 300,
              pricing: { price_details: { price: "price_cloud_minimum_due" } },
            },
          ],
        },
      }),
    );
    const { request } = buildSignedWebhookRequest(event);
    await env.POST(request);

    expect(env.stripe.customers.createBalanceTransaction).toHaveBeenCalledWith(
      "cus_minimum_due",
      expect.objectContaining({ amount: -300, currency: "usd" }),
    );
  });
});
