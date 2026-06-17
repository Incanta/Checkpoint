// Build a Stripe webhook payload + signature header pair that the real
// `stripe.webhooks.constructEvent(...)` call in the webhook handler will
// accept (or reject, for signature-failure tests).
//
// Uses the real `stripe` SDK's `webhooks.generateTestHeaderString` so the
// signature scheme stays in sync with the SDK — no hand-rolled HMAC.

import Stripe from "stripe";

export const TEST_WEBHOOK_SECRET = "whsec_test_dummy_secret";

export interface SignedRequest {
  body: string;
  signature: string;
  request: Request;
}

interface SignOpts {
  /** Override the secret used for signing. Default: `TEST_WEBHOOK_SECRET`. */
  secret?: string;
  /** Override the timestamp (epoch seconds). Default: now. */
  timestamp?: number;
  /** URL the synthetic Request reports. Default: dummy webhook URL. */
  url?: string;
}

const stripe = new Stripe("sk_test_dummy");

/**
 * Sign a Stripe event payload and wrap it in a fetch `Request` ready to
 * pass to the webhook route handler.
 */
export function buildSignedWebhookRequest<T>(
  event: Stripe.Event | T,
  opts: SignOpts = {},
): SignedRequest {
  const body = JSON.stringify(event);
  const secret = opts.secret ?? TEST_WEBHOOK_SECRET;
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);

  const signature = stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret,
    timestamp,
    scheme: "v1",
  });

  const request = new Request(
    opts.url ?? "https://app.local/api/webhooks/stripe",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": signature,
      },
      body,
    },
  );

  return { body, signature, request };
}

/** Build a Request with no `stripe-signature` header (for rejection tests). */
export function buildUnsignedWebhookRequest<T>(event: Stripe.Event | T): Request {
  return new Request("https://app.local/api/webhooks/stripe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
}
