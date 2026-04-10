import { NextResponse } from "next/server";
import config from "@incanta/config";
import { Logger } from "~/server/logging";

export async function POST(request: Request) {
  const enabled = config.get<boolean>("newsletter.kit.enabled");
  if (!enabled) {
    return NextResponse.json(
      { error: "Newsletter signup is not enabled" },
      { status: 404 },
    );
  }

  let body: { email?: string; name?: string };
  try {
    body = (await request.json()) as { email?: string; name?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { email, name } = body;
  if (!email || typeof email !== "string") {
    return NextResponse.json(
      { error: "Email is required" },
      { status: 400 },
    );
  }

  const apiKey = config.get<string>("newsletter.kit.api-key");
  if (!apiKey) {
    Logger.warn("[Newsletter] Kit API key not configured");
    return NextResponse.json(
      { error: "Newsletter service not configured" },
      { status: 503 },
    );
  }

  // Split name into first/last for Kit.com
  const nameParts = (name ?? "").trim().split(/\s+/);
  const firstName = nameParts[0] ?? "";
  const lastName = nameParts.slice(1).join(" ");

  try {
    const res = await fetch("https://api.kit.com/v4/subscribers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Kit-Api-Key": apiKey,
      },
      body: JSON.stringify({
        first_name: firstName,
        email_address: email,
        state: "active",
        fields: {
          "Last name": lastName,
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      Logger.warn(
        `[Newsletter] Kit API returned ${res.status}: ${text}`,
      );
      return NextResponse.json(
        { error: "Failed to subscribe" },
        { status: 502 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    Logger.error(
      `[Newsletter] Failed to call Kit API: ${String(err)}`,
    );
    return NextResponse.json(
      { error: "Newsletter service unavailable" },
      { status: 502 },
    );
  }
}
