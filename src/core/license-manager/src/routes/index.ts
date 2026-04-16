import { Router } from "express";
import { validateLicense } from "./validate.js";
import { reportUsage } from "./report-usage.js";
import { healthCheck } from "./health.js";

export function routes(): Router {
  const router = Router();

  router.post("/api/license/validate", validateLicense);
  router.post("/api/license/report-usage", reportUsage);
  router.get("/health", healthCheck);

  return router;
}
