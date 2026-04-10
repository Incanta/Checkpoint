import { NextResponse } from "next/server";
import config from "@incanta/config";
import { enabledProviderIds } from "~/server/auth/config";
import { isLicenseManager } from "~/server/license-utils";

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  discord: "Discord",
  github: "GitHub",
  gitlab: "GitLab",
  auth0: "Auth0",
  okta: "Okta",
  slack: "Slack",
};

export function GET() {
  const providers = enabledProviderIds.map((id) => ({
    id,
    name: PROVIDER_DISPLAY_NAMES[id] ?? id,
  }));

  const showNewsletter =
    isLicenseManager() && config.get<boolean>("newsletter.kit.enabled");

  return NextResponse.json({ providers, showNewsletter });
}
