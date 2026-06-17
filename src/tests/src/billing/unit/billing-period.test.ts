// Tests for `getBillingPeriod` — the helper that maps a date to a {year, month}
// billing window anchored on a configurable day of the month.

import { describe, it, expect } from "vitest";
import { getBillingPeriod } from "~/server/billing/billing-period";

describe("getBillingPeriod", () => {
  it("anchor=1 returns the calendar month for any day", () => {
    expect(getBillingPeriod(new Date("2026-06-01T00:00:00Z"), 1)).toEqual({
      year: 2026,
      month: 6,
    });
    expect(getBillingPeriod(new Date("2026-06-15T00:00:00Z"), 1)).toEqual({
      year: 2026,
      month: 6,
    });
    expect(getBillingPeriod(new Date("2026-06-30T23:59:59Z"), 1)).toEqual({
      year: 2026,
      month: 6,
    });
  });

  it("anchor=12 — before anchor day rolls back one month", () => {
    expect(getBillingPeriod(new Date("2026-03-03T00:00:00Z"), 12)).toEqual({
      year: 2026,
      month: 2,
    });
  });

  it("anchor=12 — on or after anchor day stays in the current month", () => {
    expect(getBillingPeriod(new Date("2026-03-12T00:00:00Z"), 12)).toEqual({
      year: 2026,
      month: 3,
    });
    expect(getBillingPeriod(new Date("2026-03-15T00:00:00Z"), 12)).toEqual({
      year: 2026,
      month: 3,
    });
  });

  it("crosses the year boundary when before anchor in January", () => {
    expect(getBillingPeriod(new Date("2026-01-05T00:00:00Z"), 12)).toEqual({
      year: 2025,
      month: 12,
    });
  });

  it("anchor=31 in February falls back to the last day of the month", () => {
    // Non-leap year: Feb has 28 days. Anchor=31 effectively → 28.
    // Feb 27 is BEFORE the effective anchor → previous month (Jan).
    expect(getBillingPeriod(new Date("2025-02-27T00:00:00Z"), 31)).toEqual({
      year: 2025,
      month: 1,
    });
    // Feb 28 (the effective anchor) → current month (Feb).
    expect(getBillingPeriod(new Date("2025-02-28T00:00:00Z"), 31)).toEqual({
      year: 2025,
      month: 2,
    });
  });

  it("leap February treats Feb 29 as the effective anchor for anchor=31", () => {
    expect(getBillingPeriod(new Date("2024-02-28T00:00:00Z"), 31)).toEqual({
      year: 2024,
      month: 1,
    });
    expect(getBillingPeriod(new Date("2024-02-29T00:00:00Z"), 31)).toEqual({
      year: 2024,
      month: 2,
    });
  });

  it("anchor=31 in 30-day months caps at 30", () => {
    expect(getBillingPeriod(new Date("2026-04-29T00:00:00Z"), 31)).toEqual({
      year: 2026,
      month: 3,
    });
    expect(getBillingPeriod(new Date("2026-04-30T00:00:00Z"), 31)).toEqual({
      year: 2026,
      month: 4,
    });
  });
});
