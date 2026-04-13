import "server-only";

/**
 * Determine which billing period a given date falls into based on the
 * subscription's billing cycle anchor day.
 *
 * The returned year/month represent the period that STARTED on the anchor
 * day. For example, with anchor 12:
 *   - March 3  → Feb (period started Feb 12)
 *   - March 15 → Mar (period started Mar 12)
 *
 * Handles short months per Stripe's convention: an anchor of 31 in February
 * uses the last day of the month (28 or 29).
 *
 * Default anchor of 1 preserves calendar-month behavior.
 */
export function getBillingPeriod(
  date: Date,
  anchorDay: number,
): { year: number; month: number } {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1; // 1-12
  const day = date.getUTCDate();

  // Effective anchor for this month (handle months shorter than anchor)
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const effectiveAnchor = Math.min(anchorDay, daysInMonth);

  if (day >= effectiveAnchor) {
    return { year, month };
  }

  // Before anchor → previous month's billing period
  if (month === 1) {
    return { year: year - 1, month: 12 };
  }
  return { year, month: month - 1 };
}
