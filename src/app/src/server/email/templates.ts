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

export function inviteToSignupEmail(
  inviterName: string,
  signupUrl: string,
  orgSummary?: string,
): EmailTemplate {
  const subject = "You've been invited to Checkpoint";
  const accessLine = orgSummary
    ? `<p>You'll be given access to: <strong>${esc(orgSummary)}</strong>.</p>`
    : "";
  const html = layout(subject, `
    ${heading("You're Invited")}
    <p><strong>${esc(inviterName)}</strong> has invited you to create an account on Checkpoint.</p>
    ${accessLine}
    ${button("Accept Invite & Sign Up", signupUrl)}
    <p class="muted">If you weren't expecting this, you can safely ignore this email.</p>
  `);
  const text = `${inviterName} has invited you to create an account on Checkpoint.${
    orgSummary ? `\n\nYou'll be given access to: ${orgSummary}.` : ""
  }\n\nAccept & sign up here: ${signupUrl}\n`;
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
 * Generic notification: use when you need a quick one-off email
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

export interface ServerUpdateEmailInput {
  currentVersion: string;
  latestVersion: string;
  channel: "release" | "nightly";
  commit: string | null;
  /** Link to the admin update panel, when an external URL is configured. */
  adminUrl: string | null;
  /**
   * Whether this deployment can install the update from the panel. False for a
   * pinned or air-gapped deployment, whose version lives in its configuration.
   */
  selfUpdatable: boolean;
}

/**
 * Sent by src/server/updates/check.ts when the watched channel carries a newer
 * server build. Nothing ever installs itself, so the mail's job is to say what
 * changed and where to go: the admin panel for a self-updating deployment, or
 * the deployment's own configuration for a pinned one.
 */
export function serverUpdateAvailableEmail(
  input: ServerUpdateEmailInput,
): EmailTemplate {
  const { currentVersion, latestVersion, channel, commit, adminUrl } = input;

  const subject =
    channel === "nightly"
      ? `Checkpoint nightly ${latestVersion} is available`
      : `Checkpoint ${latestVersion} is available`;

  const action = input.selfUpdatable
    ? "Download and install it from the admin panel when you are ready. Downloading does not interrupt anything; only installing restarts the services."
    : "This deployment is pinned to a fixed version, so update the version in its configuration and redeploy.";

  const ctaHtml =
    input.selfUpdatable && adminUrl ? button("Open the update panel", adminUrl) : "";

  const commitHtml = commit
    ? `<p class="muted">Built from commit <span class="code">${esc(commit)}</span>.</p>`
    : "";

  const html = layout(
    subject,
    `
    ${heading("A server update is available")}
    <p>This Checkpoint instance is running <span class="code">${esc(currentVersion)}</span>.
    The <strong>${esc(channel)}</strong> channel is now at <span class="code">${esc(latestVersion)}</span>.</p>
    <p>${esc(action)}</p>
    ${ctaHtml}
    ${commitHtml}
    <hr />
    <p class="muted">Nothing has been installed. You are receiving this because
    update notifications are enabled for this instance
    (<span class="code">updates.enabled</span>).</p>
  `,
  );

  const text = [
    subject,
    "",
    `This Checkpoint instance is running ${currentVersion}.`,
    `The ${channel} channel is now at ${latestVersion}.`,
    "",
    action,
    ...(adminUrl && input.selfUpdatable ? ["", adminUrl] : []),
    ...(commit ? ["", `Built from commit ${commit}.`] : []),
    "",
    "Nothing has been installed. You are receiving this because update notifications are enabled for this instance (updates.enabled).",
    "",
  ].join("\n");

  return { subject, html, text };
}
