import crypto from "node:crypto";
import { type Request, type Response } from "express";
import { getDb } from "../db.js";
import {
  getFeaturesForTier,
  signValidationToken,
  type LicenseTier,
} from "../license-utils.js";

export async function validateLicense(
  req: Request,
  res: Response,
): Promise<void> {
  const { key, secret } = req.body as { key?: string; secret?: string };

  if (!key || !secret) {
    res.status(400).json({ error: "Missing key or secret" });
    return;
  }

  const db = getDb();
  const license = await db.license.findUnique({ where: { key } });

  if (!license) {
    res.status(404).json({ valid: false, error: "License not found" });
    return;
  }

  const secretHash = crypto.createHash("sha256").update(secret).digest("hex");
  if (secretHash !== license.secretHash) {
    res.status(401).json({ valid: false, error: "Invalid secret" });
    return;
  }

  if (!license.active) {
    res.status(403).json({ valid: false, error: "License revoked" });
    return;
  }

  const tier = license.tier as LicenseTier;
  const features = getFeaturesForTier(tier);
  const token = signValidationToken({ tier, features, licenseKey: key });

  res.json({
    token,
    valid: true,
    tier,
    features,
  });
}
