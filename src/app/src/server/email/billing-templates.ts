import "server-only";

import type { EmailTemplate } from "./templates";
import config from "@incanta/config";

const BRAND_COLOR = "#6366f1";

function layout(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <style>
    body { margin:0; padding:0; background:#f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    .wrapper { max-width:600px; margin:0 auto; padding:32px 16px; }
    .card { background:#ffffff; border-radius:8px; padding:32px; border:1px solid #e4e4e7; }
    .brand { color:${BRAND_COLOR}; font-size:20px; font-weight:700; margin-bottom:24px; }
    .body-text { color:#27272a; font-size:15px; line-height:1.6; }
    .body-text p { margin:0 0 16px; }
    .btn { display:inline-block; background:${BRAND_COLOR}; color:#ffffff !important; text-decoration:none; padding:10px 24px; border-radius:6px; font-weight:600; font-size:14px; }
    .btn-danger { background:#ef4444; }
    .muted { color:#71717a; font-size:13px; }
    .footer { text-align:center; margin-top:24px; color:#a1a1aa; font-size:12px; }
    .amount { font-size:24px; font-weight:700; color:#27272a; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="card">
      <div class="brand">Checkpoint</div>
      <div class="body-text">
        ${bodyHtml}
      </div>
    </div>
    <div class="footer">
      Checkpoint VCS · Billing notification
    </div>
  </div>
</body>
</html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function button(label: string, url: string, danger = false): string {
  const cls = danger ? "btn btn-danger" : "btn";
  return `<p style="text-align:center;margin:24px 0"><a class="${cls}" href="${esc(config.get<string>("server.external-url") + url)}">${esc(label)}</a></p>`;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ── Templates ────────────────────────────────────────────────────

export function paymentFailedEmail(
  orgName: string,
  amountCents: number,
  retryUrl: string,
): EmailTemplate {
  const amount = formatCents(amountCents);
  return {
    subject: `Payment failed for ${orgName}`,
    html: layout(
      `Payment failed for ${orgName}`,
      `<p>We were unable to collect a payment of <span class="amount">${amount}</span> for <strong>${esc(orgName)}</strong>.</p>
       <p>Please update your payment method to avoid service interruption. If payment is not received <strong>within ${config.get<number>("stripe.delinquency.suspend-after-days")} days</strong>, your organization's <strong>access will be suspended</strong>.</p>
       <p><strong>Important:</strong> If the balance remains unpaid for ${config.get<number>("stripe.delinquency.delete-after-days")} days, all data for your organization will be <strong>permanently deleted</strong>.</p>
       ${button("Update Payment Method", retryUrl)}
       <p class="muted">If you believe this is an error, please contact support.</p>`,
    ),
    text: `Payment of ${amount} failed for ${orgName}. Please update your payment method at ${retryUrl} to avoid service interruption. Access will be suspended after ${config.get<number>("stripe.delinquency.suspend-after-days")} days and data will be deleted after ${config.get<number>("stripe.delinquency.delete-after-days")} days if unpaid.`,
  };
}

export function accountSuspendedEmail(
  orgName: string,
  resumeUrl: string,
): EmailTemplate {
  return {
    subject: `Access suspended for ${orgName}`,
    html: layout(
      `Access suspended for ${orgName}`,
      `<p>Access to <strong>${esc(orgName)}</strong> has been suspended due to an outstanding balance.</p>
       <p>Your data is still safe, but all members have lost access. Please resume your subscription and settle the outstanding balance to restore access.</p>
       <p><strong>Important:</strong> If the balance is not settled within ${config.get<number>("stripe.delinquency.delete-after-days")} days of the original payment failure, your data will be permanently deleted.</p>
       ${button("Resume Subscription", resumeUrl, true)}`,
    ),
    text: `Access to ${orgName} has been suspended due to an outstanding balance. Resume your subscription at ${resumeUrl} to restore access. Data will be deleted after ${config.get<number>("stripe.delinquency.delete-after-days")} days.`,
  };
}

export function accountDeletionWarningEmail(
  orgName: string,
  daysRemaining: number,
  resumeUrl: string,
): EmailTemplate {
  if (daysRemaining <= 0) {
    return {
      subject: `⚠️ Data deletion for ${orgName}`,
      html: layout(
        `Data deletion notification for ${orgName}`,
        `<p><strong>Your data for ${esc(orgName)} has been permanently deleted due to non-payment.</strong></p>`,
      ),
      text: `ALERT: Data for ${orgName} has been permanently deleted due to non-payment.`,
    };
  }

  return {
    subject: `⚠️ Data deletion warning for ${orgName}`,
    html: layout(
      `Data deletion warning for ${orgName}`,
      `<p><strong>Your data for ${esc(orgName)} will be permanently deleted in ${daysRemaining} day${daysRemaining !== 1 ? "s" : ""}.</strong></p>
       <p>Please resume your subscription immediately to prevent data loss. Once deleted, your repositories and all associated data cannot be recovered.</p>
       ${button("Resume Subscription Now", resumeUrl, true)}`,
    ),
    text: `WARNING: Data for ${orgName} will be permanently deleted in ${daysRemaining} day(s). Resume your subscription at ${resumeUrl} to prevent data loss.`,
  };
}

export function cardExpiryEmail(
  orgName: string,
  last4: string,
  expiryDate: string,
  updateUrl: string,
): EmailTemplate {
  return {
    subject: `Payment method expiring soon for ${orgName}`,
    html: layout(
      `Payment method expiring soon`,
      `<p>The payment method ending in <strong>${esc(last4)}</strong> associated with <strong>${esc(orgName)}</strong> expires on <strong>${esc(expiryDate)}</strong>.</p>
       <p>Please update your payment method to ensure uninterrupted service.</p>
       ${button("Update Payment Method", updateUrl)}`,
    ),
    text: `The payment method ending in ${last4} for ${orgName} expires on ${expiryDate}. Update it at ${updateUrl}.`,
  };
}

export function trialEndingEmail(
  orgName: string,
  daysRemaining: number,
): EmailTemplate {
  return {
    subject: `Your free trial for ${orgName} ends in ${daysRemaining} days`,
    html: layout(
      `Trial ending soon`,
      `<p>Your free trial for <strong>${esc(orgName)}</strong> ends in <strong>${daysRemaining} day${daysRemaining !== 1 ? "s" : ""}</strong>.</p>
       <p>After the trial ends, you'll be automatically billed based on your usage. No action is needed to continue — your saved payment method will be charged.</p>
       <p>If you'd like to cancel before the trial ends, visit your organization's billing settings.</p>`,
    ),
    text: `Your free trial for ${orgName} ends in ${daysRemaining} day(s). You'll be automatically billed after the trial ends.`,
  };
}

export function trialChargeWarningEmail(
  orgName: string,
  daysRemaining: number,
): EmailTemplate {
  return {
    subject: `Action required: ${orgName} will be charged in ${daysRemaining} days`,
    html: layout(
      `You'll be charged soon`,
      `<p>Your free trial for <strong>${esc(orgName)}</strong> ends in <strong>${daysRemaining} day${daysRemaining !== 1 ? "s" : ""}</strong>.</p>
       <p><strong>Your saved payment method will be automatically charged</strong> for your usage once the trial ends.</p>
       <p>If you do not wish to be charged, cancel your trial before it ends in your organization's billing settings.</p>`,
    ),
    text: `Your free trial for ${orgName} ends in ${daysRemaining} day(s). Your saved payment method will be automatically charged. Cancel before the trial ends to avoid charges.`,
  };
}

export function invoiceIssuedEmail(
  orgName: string,
  amountCents: number,
  viewUrl: string,
): EmailTemplate {
  const amount = formatCents(amountCents);
  return {
    subject: `Invoice for ${orgName}: ${amount}`,
    html: layout(
      `Invoice for ${orgName}`,
      `<p>A new invoice of <span class="amount">${amount}</span> has been issued for <strong>${esc(orgName)}</strong>.</p>
       <p>This amount will be charged to your saved payment method.</p>
       ${button("View Invoice", viewUrl)}`,
    ),
    text: `Invoice for ${orgName}: ${amount}. View at ${viewUrl}.`,
  };
}

export function subscriptionResumedEmail(orgName: string): EmailTemplate {
  return {
    subject: `Subscription resumed for ${orgName}`,
    html: layout(
      `Subscription resumed`,
      `<p>Your subscription for <strong>${esc(orgName)}</strong> has been successfully resumed.</p>
       <p>All members now have full access again. Any outstanding invoices have been processed.</p>`,
    ),
    text: `Subscription resumed for ${orgName}. All members now have full access.`,
  };
}
