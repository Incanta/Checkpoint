// Factory functions for the DB shapes billing code reads. Keep these tiny
// and explicit — tests should be readable.
//
// `makeUser` lives here (not the shared harness) because premium's User
// model has the `trialUsed` field that main's doesn't. `makeOrg` and
// `makeInvoice` are likewise premium-specific (subscriptionTier,
// stripeCustomerId, …). `makeStripeEvent` has no DB shape and is purely a
// Stripe SDK helper. The shared `nextId` counter is reused so id ordering
// stays sequential across fixture calls from both layers.

import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { nextId } from "../../harness/fixtures";

export interface MakeUserOpts {
  email?: string;
  trialUsed?: boolean;
}

export async function makeUser(
  db: PrismaClient,
  opts: MakeUserOpts = {},
): Promise<{ id: string; email: string }> {
  const user = await db.user.create({
    data: {
      email: opts.email ?? `user-${nextId("u")}@test.local`,
      emailVerified: true,
      trialUsed: opts.trialUsed ?? false,
    },
  });
  return { id: user.id, email: user.email };
}

export interface MakeOrgOpts {
  name?: string;
  tier?: "BASIC" | "PRO" | "STUDIO" | "INCANTA";
  status?:
    | "TRIAL"
    | "ACTIVE"
    | "PAST_DUE"
    | "SUSPENDED"
    | "CANCELED"
    | "DELETED";
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  trialEndsAt?: Date | null;
  delinquentSince?: Date | null;
  suspendedAt?: Date | null;
  billingCycleAnchor?: number;
  creditBalanceCents?: number;
  scheduledTier?: "BASIC" | "PRO" | "STUDIO" | "INCANTA" | null;
  scheduledTierAt?: Date | null;
}

export async function makeOrg(
  db: PrismaClient,
  opts: MakeOrgOpts = {},
): Promise<{ id: string; name: string }> {
  // Distinguish "not provided" from "explicitly null" for the Stripe fields,
  // so callers can null them out to test the no-customer / no-subscription
  // paths.
  const stripeCustomerId =
    "stripeCustomerId" in opts
      ? opts.stripeCustomerId
      : `cus_test_${nextId("c")}`;
  const stripeSubscriptionId =
    "stripeSubscriptionId" in opts
      ? opts.stripeSubscriptionId
      : `sub_test_${nextId("s")}`;

  const org = await db.org.create({
    data: {
      name: opts.name ?? `org-${nextId("o")}`,
      subscriptionTier: opts.tier ?? "BASIC",
      subscriptionStatus: opts.status ?? "ACTIVE",
      stripeCustomerId,
      stripeSubscriptionId,
      trialEndsAt: opts.trialEndsAt ?? null,
      delinquentSince: opts.delinquentSince ?? null,
      suspendedAt: opts.suspendedAt ?? null,
      billingCycleAnchor: opts.billingCycleAnchor ?? 1,
      creditBalanceCents: opts.creditBalanceCents ?? 0,
      scheduledTier: opts.scheduledTier ?? null,
      scheduledTierAt: opts.scheduledTierAt ?? null,
    },
  });
  return { id: org.id, name: org.name };
}

export interface MakeInvoiceOpts {
  stripeInvoiceId?: string;
  year?: number;
  month?: number;
  status?: "DRAFT" | "ISSUED" | "PAID" | "FAILED" | "HELD";
  subtotalCents?: number;
  totalCents?: number;
  creditAppliedCents?: number;
  minimumDueAddedCents?: number;
}

export async function makeInvoice(
  db: PrismaClient,
  orgId: string,
  opts: MakeInvoiceOpts = {},
): Promise<{ id: string; stripeInvoiceId: string | null }> {
  const now = new Date();
  const inv = await db.invoice.create({
    data: {
      orgId,
      stripeInvoiceId: opts.stripeInvoiceId ?? `in_test_${nextId("i")}`,
      year: opts.year ?? now.getFullYear(),
      month: opts.month ?? now.getMonth() + 1,
      status: opts.status ?? "ISSUED",
      subtotalCents: opts.subtotalCents ?? 0,
      totalCents: opts.totalCents ?? 0,
      creditAppliedCents: opts.creditAppliedCents ?? 0,
      minimumDueAddedCents: opts.minimumDueAddedCents ?? 0,
    },
  });
  return { id: inv.id, stripeInvoiceId: inv.stripeInvoiceId };
}

/**
 * Build a Stripe `Event` envelope with sensible defaults. The `data.object`
 * shape is whatever the test wants (we don't validate against the SDK types
 * because tests often need partial fixtures).
 */
export function makeStripeEvent<T>(
  type: string,
  dataObject: T,
  overrides: { id?: string; livemode?: boolean; created?: number } = {},
): Stripe.Event {
  // Cast through `unknown` at the boundary: the Stripe SDK types
  // `data.object` as a tagged union of every Stripe resource shape and
  // `type` as a string-literal union of every event name. Tests build
  // synthetic events with partial payloads and event names the SDK may
  // not yet know about — those are deliberately not validated here.
  return {
    id: overrides.id ?? `evt_test_${randomUUID()}`,
    object: "event",
    api_version: "2026-03-25.dahlia",
    created: overrides.created ?? Math.floor(Date.now() / 1000),
    data: {
      object: dataObject,
      previous_attributes: null,
    },
    livemode: overrides.livemode ?? false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type,
  } as unknown as Stripe.Event;
}
