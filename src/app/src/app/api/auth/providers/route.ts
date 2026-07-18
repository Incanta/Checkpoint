import { NextResponse } from "next/server";
import config from "@incanta/config";
import { enabledProviderIds } from "~/server/auth/config";
import { db } from "~/server/db";
import { isLicenseManager } from "~/server/license-utils";
import { getInviteMode } from "~/server/invites";

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  discord: "Discord",
  github: "GitHub",
  gitlab: "GitLab",
  auth0: "Auth0",
  okta: "Okta",
  slack: "Slack",
};

export async function GET() {
  const providers = enabledProviderIds.map((id) => ({
    id,
    name: PROVIDER_DISPLAY_NAMES[id] ?? id,
  }));

  const [userCount, settings] = await Promise.all([
    db.user.count(),
    db.instanceSettings.findUnique({ where: { id: "default" } }),
  ]);

  // Open self-registration only for the very first user, or when the instance
  // is set up AND invite-only is "public". In "member"/"admin" modes the
  // generic signup toggle is hidden; invitees register via their invite link.
  const registrationOpen =
    userCount === 0 ||
    (!!settings?.setupCompletedAt && getInviteMode() === "public");

  const showNewsletter =
    isLicenseManager() && config.get<boolean>("newsletter.kit.enabled");

  return NextResponse.json({ providers, registrationOpen, showNewsletter });
}
