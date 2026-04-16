import crypto from "node:crypto";
import { type Request, type Response } from "express";
import { getDb } from "../db.js";

export async function reportUsage(req: Request, res: Response): Promise<void> {
  const { key, secret, year, month, awuCount, aruCount } = req.body as {
    key?: string;
    secret?: string;
    year?: number;
    month?: number;
    awuCount?: number;
    aruCount?: number;
  };

  if (
    !key ||
    !secret ||
    !year ||
    !month ||
    awuCount == null ||
    aruCount == null
  ) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  const db = getDb();
  const license = await db.license.findUnique({ where: { key } });

  if (!license) {
    res.status(404).json({ error: "License not found" });
    return;
  }

  const secretHash = crypto.createHash("sha256").update(secret).digest("hex");
  if (secretHash !== license.secretHash) {
    res.status(401).json({ error: "Invalid secret" });
    return;
  }

  if (!license.active) {
    res.status(403).json({ error: "License revoked" });
    return;
  }

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

  await db.license.update({
    where: { id: license.id },
    data: { lastReportAt: new Date() },
  });

  res.json({ success: true });
}
