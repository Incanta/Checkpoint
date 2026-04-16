import { NextResponse } from "next/server";
import { enabledProviderIds } from "~/server/auth/config";
import { db } from "~/server/db";

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

  const registrationOpen = userCount === 0 || !!settings?.eulaAcceptedAt;

  return NextResponse.json({ providers, registrationOpen });
}
