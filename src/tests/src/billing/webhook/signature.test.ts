// Signature verification for POST /api/webhooks/stripe. Anything other than
// a payload signed with the configured `stripe.webhook-secret` should be
// rejected with 401.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { setupWebhookEnv } from "../harness/webhook";
import {
  buildSignedWebhookRequest,
  buildUnsignedWebhookRequest,
  TEST_WEBHOOK_SECRET,
} from "../harness/sign";
import { makeStripeEvent } from "../harness/fixtures";

describe("webhook signature", () => {
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

  it("accepts a correctly-signed event", async () => {
    const event = makeStripeEvent("invoice.finalized", {
      id: "in_sig_ok",
      customer: "cus_nonexistent",
    });
    const { request } = buildSignedWebhookRequest(event);
    const res = await env.POST(request);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: boolean };
    expect(body.received).toBe(true);
  });

  it("rejects an unsigned request with 401", async () => {
    const event = makeStripeEvent("invoice.finalized", {});
    const request = buildUnsignedWebhookRequest(event);
    const res = await env.POST(request);
    expect(res.status).toBe(401);
  });

  it("rejects a request signed with the wrong secret with 401", async () => {
    const event = makeStripeEvent("invoice.finalized", {});
    const { request } = buildSignedWebhookRequest(event, {
      secret: "whsec_wrong_secret",
    });
    const res = await env.POST(request);
    expect(res.status).toBe(401);
  });

  it("rejects a stale signature (timestamp >5 min old) with 401", async () => {
    const event = makeStripeEvent("invoice.finalized", {});
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    const { request } = buildSignedWebhookRequest(event, {
      timestamp: tenMinutesAgo,
    });
    const res = await env.POST(request);
    expect(res.status).toBe(401);
  });

  it("uses the configured TEST_WEBHOOK_SECRET (sanity check)", () => {
    expect(TEST_WEBHOOK_SECRET).toBe("whsec_test_dummy_secret");
  });
});
