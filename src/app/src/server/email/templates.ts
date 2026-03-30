import "server-only";

/**
 * Email template helpers.
 *
 * Each template function returns { subject, html, text } so callers can
 * simply spread into `sendEmail()`.  The `layout()` wrapper provides a
 * consistent branded shell around any inner HTML.
 */

// ── Base layout ──────────────────────────────────────────────────

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
    .muted { color:#71717a; font-size:13px; }
    .footer { text-align:center; margin-top:24px; color:#a1a1aa; font-size:12px; }
    .code { font-family:monospace; background:#f4f4f5; padding:2px 6px; border-radius:4px; font-size:14px; }
    hr { border:none; border-top:1px solid #e4e4e7; margin:24px 0; }
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
      Checkpoint VCS · You received this because of your notification settings.
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

// ── Helpers ──────────────────────────────────────────────────────

function button(label: string, url: string): string {
  return `<p style="text-align:center;margin:24px 0"><a class="btn" href="${esc(url)}">${esc(label)}</a></p>`;
}

function heading(text: string): string {
  return `<p style="font-size:18px;font-weight:600;margin-bottom:8px">${esc(text)}</p>`;
}

// ── Template type ────────────────────────────────────────────────

export interface EmailTemplate {
  subject: string;
  html: string;
  text: string;
}

// ── Templates ────────────────────────────────────────────────────

export function welcomeEmail(userName: string): EmailTemplate {
  const subject = "Welcome to Checkpoint";
  const html = layout(subject, `
    ${heading("Welcome!")}
    <p>Hi ${esc(userName || "there")},</p>
    <p>Thanks for joining Checkpoint. You're all set to start versioning your projects.</p>
    ${button("Get Started", "https://checkpoint.example.com")}
    <p class="muted">If you have any questions, just reply to this email.</p>
  `);
  const text = `Welcome to Checkpoint!\n\nHi ${userName || "there"},\n\nThanks for joining Checkpoint. You're all set to start versioning your projects.\n`;
  return { subject, html, text };
}

export function orgInviteEmail(
  inviterName: string,
  orgName: string,
  inviteUrl: string,
): EmailTemplate {
  const subject = `You've been invited to ${orgName} on Checkpoint`;
  const html = layout(subject, `
    ${heading("Organization Invite")}
    <p><strong>${esc(inviterName)}</strong> has invited you to join <strong>${esc(orgName)}</strong> on Checkpoint.</p>
    ${button("Accept Invite", inviteUrl)}
    <p class="muted">If you weren't expecting this, you can safely ignore this email.</p>
  `);
  const text = `${inviterName} has invited you to join ${orgName} on Checkpoint.\n\nAccept here: ${inviteUrl}\n`;
  return { subject, html, text };
}

export function changelistSubmittedEmail(
  userName: string,
  repoName: string,
  branchName: string,
  clNumber: number,
  message: string,
  repoUrl: string,
): EmailTemplate {
  const subject = `CL #${clNumber} submitted to ${repoName}/${branchName}`;
  const html = layout(subject, `
    ${heading(`New Changelist #${clNumber}`)}
    <p><strong>${esc(userName)}</strong> submitted to <strong>${esc(repoName)}</strong> on branch <span class="code">${esc(branchName)}</span>:</p>
    <blockquote style="border-left:3px solid ${BRAND_COLOR};padding-left:12px;margin:16px 0;color:#52525b">
      ${esc(message)}
    </blockquote>
    ${button("View Changelist", `${repoUrl}/history`)}
  `);
  const text = `CL #${clNumber} submitted to ${repoName}/${branchName} by ${userName}\n\n${message}\n\nView: ${repoUrl}/history\n`;
  return { subject, html, text };
}

export function branchCreatedEmail(
  userName: string,
  repoName: string,
  branchName: string,
  repoUrl: string,
): EmailTemplate {
  const subject = `Branch "${branchName}" created in ${repoName}`;
  const html = layout(subject, `
    ${heading("New Branch")}
    <p><strong>${esc(userName)}</strong> created branch <span class="code">${esc(branchName)}</span> in <strong>${esc(repoName)}</strong>.</p>
    ${button("View Repository", repoUrl)}
  `);
  const text = `${userName} created branch "${branchName}" in ${repoName}.\n\nView: ${repoUrl}\n`;
  return { subject, html, text };
}

export function memberAddedEmail(
  orgName: string,
  roleName: string,
  dashboardUrl: string,
): EmailTemplate {
  const subject = `You were added to ${orgName}`;
  const html = layout(subject, `
    ${heading("You're In!")}
    <p>You've been added to <strong>${esc(orgName)}</strong> with the role <span class="code">${esc(roleName)}</span>.</p>
    ${button("Open Dashboard", dashboardUrl)}
  `);
  const text = `You were added to ${orgName} with the role ${roleName}.\n\nDashboard: ${dashboardUrl}\n`;
  return { subject, html, text };
}

export function passwordResetEmail(
  resetUrl: string,
): EmailTemplate {
  const subject = "Reset your Checkpoint password";
  const html = layout(subject, `
    ${heading("Password Reset")}
    <p>We received a request to reset your password. Click below to choose a new one:</p>
    ${button("Reset Password", resetUrl)}
    <p class="muted">This link expires in 1 hour. If you didn't request this, you can safely ignore it.</p>
  `);
  const text = `Reset your Checkpoint password:\n\n${resetUrl}\n\nThis link expires in 1 hour.\n`;
  return { subject, html, text };
}

/**
 * Generic notification — use when you need a quick one-off email
 * that doesn't warrant its own template function.
 */
export function genericEmail(
  title: string,
  bodyLines: string[],
  ctaLabel?: string,
  ctaUrl?: string,
): EmailTemplate {
  const subject = title;
  const bodyHtml = bodyLines.map((l) => `<p>${esc(l)}</p>`).join("\n");
  const cta = ctaLabel && ctaUrl ? button(ctaLabel, ctaUrl) : "";
  const html = layout(subject, `
    ${heading(title)}
    ${bodyHtml}
    ${cta}
  `);
  const text = `${title}\n\n${bodyLines.join("\n")}\n${ctaUrl ? `\n${ctaLabel}: ${ctaUrl}\n` : ""}`;
  return { subject, html, text };
}
