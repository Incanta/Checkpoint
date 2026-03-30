import crypto from "crypto";
import { type NextRequest } from "next/server";
import { db } from "~/server/db";
import { isLicenseManager } from "~/server/license-utils";

export async function POST(request: NextRequest) {
  if (!isLicenseManager()) {
    return Response.json({ error: "Not a license manager instance" }, { status: 403 });
  }

  let body: {
    key?: string;
    secret?: string;
    year?: number;
    month?: number;
    awuCount?: number;
    aruCount?: number;
  };
  try {
    body = await request.json() as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { key, secret, year, month, awuCount, aruCount } = body;
  if (!key || !secret || !year || !month || awuCount == null || aruCount == null) {
    return Response.json({ error: "Missing required fields" }, { status: 400 });
  }

  const license = await db.license.findUnique({ where: { key } });
  if (!license) {
    return Response.json({ error: "License not found" }, { status: 404 });
  }

  const secretHash = crypto.createHash("sha256").update(secret).digest("hex");
  if (secretHash !== license.secretHash) {
    return Response.json({ error: "Invalid secret" }, { status: 401 });
  }

  if (!license.active) {
    return Response.json({ error: "License revoked" }, { status: 403 });
  }

  // Upsert the usage report
  await db.licenseUsageReport.upsert({
    where: {
      licenseId_year_month: {
        licenseId: license.id,
        year,
        month,
      },
    },
    create: {
      licenseId: license.id,
      year,
      month,
      awuCount,
      aruCount,
    },
    update: {
      awuCount,
      aruCount,
      reportedAt: new Date(),
    },
  });

  // Update last report timestamp
  await db.license.update({
    where: { id: license.id },
    data: { lastReportAt: new Date() },
  });

  return Response.json({ success: true });
}
