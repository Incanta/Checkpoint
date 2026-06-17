// Fake Stripe client. Each method is a vitest mock (`vi.fn()`) returning a
// realistic default; tests override per-test via `stripe.<resource>.<method>
// .mockResolvedValueOnce(...)` like any other vitest mock.
//
// The shape mirrors the subset of the real Stripe SDK the billing modules
// actually touch — `customers`, `subscriptions`, `invoices`, `checkout`,
// `billing.meterEvents`, `billingPortal`, plus the `webhooks.constructEvent`
// helper which we delegate to the real Stripe package for signature checks
// (so signature tests stay meaningful).

import { vi } from "vitest";
import RealStripe from "stripe";
import type Stripe from "stripe";

export interface MockStripe {
  customers: {
    create: ReturnType<typeof vi.fn>;
    retrieve: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    createBalanceTransaction: ReturnType<typeof vi.fn>;
  };
  subscriptions: {
    create: ReturnType<typeof vi.fn>;
    retrieve: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
  };
  invoices: {
    retrieve: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    pay: ReturnType<typeof vi.fn>;
    voidInvoice: ReturnType<typeof vi.fn>;
  };
  checkout: {
    sessions: {
      create: ReturnType<typeof vi.fn>;
    };
  };
  billing: {
    meterEvents: {
      create: ReturnType<typeof vi.fn>;
    };
  };
  billingPortal: {
    sessions: {
      create: ReturnType<typeof vi.fn>;
    };
  };
  webhooks: {
    constructEvent: typeof RealStripe.webhooks.constructEvent;
  };
}

/**
 * Build a fresh mock Stripe client. Each call returns a *new* instance with
 * its own vi.fn() mocks, so multiple tests don't share call history.
 */
export function createStripeMock(): MockStripe {
  // No options needed — webhooks helpers don't depend on API version
  // pinning or any other constructor config.
  const realWebhooks = new RealStripe("sk_test_dummy").webhooks;

  return {
    customers: {
      create: vi.fn().mockResolvedValue({ id: "cus_test_default" }),
      retrieve: vi.fn().mockResolvedValue({
        id: "cus_test_default",
        deleted: false,
        balance: 0,
      }),
      update: vi.fn().mockResolvedValue({ id: "cus_test_default" }),
      createBalanceTransaction: vi
        .fn()
        .mockResolvedValue({ id: "cbtxn_test_default", amount: 0 }),
    },
    subscriptions: {
      create: vi.fn().mockResolvedValue({
        id: "sub_test_default",
        status: "active",
        items: { data: [] },
      }),
      retrieve: vi.fn().mockResolvedValue({
        id: "sub_test_default",
        status: "active",
        items: { data: [] },
      }),
      update: vi.fn().mockResolvedValue({
        id: "sub_test_default",
        status: "active",
      }),
      cancel: vi.fn().mockResolvedValue({
        id: "sub_test_default",
        status: "canceled",
      }),
      list: vi.fn().mockResolvedValue({ data: [] }),
    },
    invoices: {
      retrieve: vi.fn().mockResolvedValue({
        id: "in_test_default",
        status: "paid",
      }),
      list: vi.fn().mockResolvedValue({ data: [] }),
      pay: vi.fn().mockResolvedValue({ id: "in_test_default", status: "paid" }),
      voidInvoice: vi
        .fn()
        .mockResolvedValue({ id: "in_test_default", status: "void" }),
    },
    checkout: {
      sessions: {
        create: vi.fn().mockResolvedValue({
          id: "cs_test_default",
          url: "https://checkout.stripe.com/test",
        }),
      },
    },
    billing: {
      meterEvents: {
        create: vi.fn().mockResolvedValue({ identifier: "me_test_default" }),
      },
    },
    billingPortal: {
      sessions: {
        create: vi.fn().mockResolvedValue({
          id: "bps_test_default",
          url: "https://billing.stripe.com/test",
        }),
      },
    },
    webhooks: realWebhooks,
  };
}
