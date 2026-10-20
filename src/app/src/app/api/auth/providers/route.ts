import { NextResponse } from "next/server";
import config from "@incanta/config";
import { enabledIdentityProviders } from "~/server/auth/config";
import { emailPasswordEnabled, passkeysEnabled } from "~/server/auth/methods";
import { db } from "~/server/db";
import { isLicenseManager } from "~/server/license-utils";
import { getInviteMode } from "~/server/invites";

export async function GET() {
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

  return NextResponse.json({
    providers: enabledIdentityProviders,
    emailPassword: emailPasswordEnabled(),
    passkeys: passkeysEnabled(),
    registrationOpen,
    showNewsletter,
  });
}
