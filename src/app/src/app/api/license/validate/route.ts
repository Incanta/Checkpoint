import crypto from "crypto";
import { type NextRequest } from "next/server";
import { db } from "~/server/db";
import { isLicenseManager, getFeaturesForTier, type LicenseTier } from "~/server/license-utils";

export async function POST(request: NextRequest) {
  if (!isLicenseManager()) {
    return Response.json({ error: "Not a license manager instance" }, { status: 403 });
  }

  let body: { key?: string; secret?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { key, secret } = body;
  if (!key || !secret) {
    return Response.json({ error: "Missing key or secret" }, { status: 400 });
  }

  const license = await db.license.findUnique({ where: { key } });
  if (!license) {
    return Response.json({ valid: false, error: "License not found" }, { status: 404 });
  }

  const secretHash = crypto.createHash("sha256").update(secret).digest("hex");
  if (secretHash !== license.secretHash) {
    return Response.json({ valid: false, error: "Invalid secret" }, { status: 401 });
  }

  if (!license.active) {
    return Response.json({ valid: false, error: "License revoked" }, { status: 403 });
  }

  const tier = license.tier as LicenseTier;
  return Response.json({
    valid: true,
    tier,
    features: getFeaturesForTier(tier),
  });
}
