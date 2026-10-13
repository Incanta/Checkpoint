import { Router } from "express";
import { getStorageBackend } from "../storage/backend.js";
import { verifyRepoToken } from "../utils/repo-token.js";

export function routeRepoSize(): Router {
  const router = Router();

  router.get("/repo-size", async (req, res) => {
    const auth = verifyRepoToken(req.headers["authorization"], false);
    if (!auth.ok) {
      res.status(auth.status).send(auth.message);
      return;
    }
    const { basePath } = auth;

    try {
      // Computed on demand from the backend (local disk walk or S3 list). This
      // route serves the gateway modes (local / s3); R2 repo size comes from
      // the Cloudflare usage API in the app, not here.
      const backend = await getStorageBackend();
      const size = await backend.sizeUnder(basePath);
      res.status(200).json({ size });
    } catch (e: any) {
      console.error(`Failed to read repo size for ${basePath}:`, e.message);
      res.status(500).send(e.message);
    }
  });

  return router;
}
