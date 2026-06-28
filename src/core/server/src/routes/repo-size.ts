import { Router } from "express";
import jwt from "njwt";
import config from "@incanta/config";
import { getStorageBackend } from "../storage/backend.js";

interface JWTClaims {
  iss: string;
  sub: string;
  userId: string;
  orgId: string;
  repoId: string;
  mode: string;
  basePath: string;
}

export function routeRepoSize(): Router {
  const router = Router();

  router.get("/repo-size", async (req, res) => {
    const authorizationHeader = req.headers["authorization"];
    if (!authorizationHeader) {
      res.status(401).send("Unauthorized");
      return;
    }

    const [type, token] = authorizationHeader.split(" ");

    if (type !== "Bearer") {
      res.status(401).send("Unauthorized");
      return;
    }

    const verifiedToken = jwt.verify(
      token,
      config.get("storage.jwt.signing-key"),
    );

    if (!verifiedToken) {
      res.status(401).send("Unauthorized");
      return;
    }

    const claims: JWTClaims = verifiedToken.body.toJSON() as any;

    const basePath = `/${claims.orgId}/${claims.repoId}`;

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
