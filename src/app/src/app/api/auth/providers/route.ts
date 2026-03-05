import { NextResponse } from "next/server";
import { enabledProviderIds } from "~/server/auth/config";

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

  return NextResponse.json(providers);
}
