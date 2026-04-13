import { Router } from "express";
import config from "@incanta/config";
import njwt from "njwt";
import { promises as fs } from "fs";
import { getFilerUrl } from "../utils/filer.js";

interface SystemJWTClaims {
  iss: string;
  system: boolean;
  action: string;
  path: string;
}

/**
 * System routes for internal API-to-storage-server communication.
 * These routes are protected by system JWT tokens that have `system: true` claim.
 */
export function routeSystem(): Router {
  const router = Router();

  router.post("/system/mkdir", async (req, res) => {
    // Verify system JWT
    const authorizationHeader = req.headers["authorization"];
    if (!authorizationHeader) {
      res.status(401).send("Unauthorized: Missing authorization header");
      return;
    }

    const [type, token] = authorizationHeader.split(" ");

    if (type !== "Bearer") {
      res.status(401).send("Unauthorized: Invalid authorization type");
      return;
    }

    let claims: SystemJWTClaims;
    try {
      const verifiedToken = njwt.verify(
        token,
        config.get<string>("storage.jwt.signing-key"),
      );

      if (!verifiedToken) {
        res.status(401).send("Unauthorized: Invalid token");
        return;
      }

      claims = verifiedToken.body.toJSON() as unknown as SystemJWTClaims;
    } catch (_error) {
      console.error("JWT verification failed:", _error);
      res.status(401).send("Unauthorized: Token verification failed");
      return;
    }

    // Verify this is a system token
    if (!claims.system || claims.iss !== "checkpoint-api") {
      res.status(403).send("Forbidden: Not a system token");
      return;
    }

    // Verify action
    if (claims.action !== "mkdir") {
      res.status(403).send("Forbidden: Invalid action for this endpoint");
      return;
    }

    const body = req.body as { path?: string };
    const path = body.path;
    if (!path) {
      res.status(400).send("Bad Request: Missing path");
      return;
    }

    // Verify the path in the request matches the path in the token
    if (path !== claims.path) {
      res.status(403).send("Forbidden: Path mismatch");
      return;
    }

    // Validate path format (should be /orgId or /orgId/repoId)
    if (!path.match(/^\/[^/]+\/?$/) && !path.match(/^\/[^/]+\/[^/]+\/?$/)) {
      res.status(400).send("Bad Request: Invalid path format");
      return;
    }

    if (config.get<boolean>("storage.seaweedfs.stub.enabled")) {
      // we can just make the directory locally without going through the filer API
      const localPath = `${config.get<string>(
        "storage.seaweedfs.stub.storage-path",
      )}${path}`;

      try {
        await fs.mkdir(localPath, { recursive: true });
        console.log(`Created local directory: ${localPath}`);
        res.status(201).json({ success: true, path });
      } catch (error) {
        console.error("Error creating local directory:", error);
        res.status(500).send(`Internal server error: ${error}`);
      }

      return;
    }

    // Create directory in filer (SeaweedFS or local stub)
    const filerUrl = getFilerUrl(true);

    const filerToken = njwt.create(
      {
        iss: "checkpoint-vcs",
        sub: "system",
        userId: "system",
        mode: "write",
        basePath: `/`,
      },
      config.get<string>("storage.jwt.signing-key"),
    );

    filerToken.setExpiration(Date.now() + 1000);

    try {
      // SeaweedFS filer creates directories by posting to the path with trailing slash
      const dirPath = path.endsWith("/") ? path : `${path}/`;
      const response = await fetch(`${filerUrl}${dirPath}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${filerToken.compact()}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Failed to create directory in SeaweedFS: ${errorText}`);
        res.status(500).send(`Failed to create directory: ${errorText}`);
        return;
      }

      console.log(`Created directory: ${path}`);
      res.status(201).json({ success: true, path });
    } catch (error) {
      console.error("Error creating directory in SeaweedFS:", error);
      res.status(500).send(`Internal server error: ${error}`);
    }
  });

  router.post("/system/rmdir", async (req, res) => {
    const authorizationHeader = req.headers["authorization"];
    if (!authorizationHeader) {
      res.status(401).send("Unauthorized: Missing authorization header");
      return;
    }

    const [type, token] = authorizationHeader.split(" ");

    if (type !== "Bearer") {
      res.status(401).send("Unauthorized: Invalid authorization type");
      return;
    }

    let claims: SystemJWTClaims;
    try {
      const verifiedToken = njwt.verify(
        token,
        config.get<string>("storage.jwt.signing-key"),
      );

      if (!verifiedToken) {
        res.status(401).send("Unauthorized: Invalid token");
        return;
      }

      claims = verifiedToken.body.toJSON() as unknown as SystemJWTClaims;
    } catch (_error) {
      console.error("JWT verification failed:", _error);
      res.status(401).send("Unauthorized: Token verification failed");
      return;
    }

    if (!claims.system || claims.iss !== "checkpoint-api") {
      res.status(403).send("Forbidden: Not a system token");
      return;
    }

    if (claims.action !== "rmdir") {
      res.status(403).send("Forbidden: Invalid action for this endpoint");
      return;
    }

    const body = req.body as { path?: string };
    const path = body.path;
    if (!path) {
      res.status(400).send("Bad Request: Missing path");
      return;
    }

    if (path !== claims.path) {
      res.status(403).send("Forbidden: Path mismatch");
      return;
    }

    if (!path.match(/^\/[^/]+\/?$/) && !path.match(/^\/[^/]+\/[^/]+\/?$/)) {
      res.status(400).send("Bad Request: Invalid path format");
      return;
    }

    if (config.get<boolean>("storage.seaweedfs.stub.enabled")) {
      const localPath = `${config.get<string>(
        "storage.seaweedfs.stub.storage-path",
      )}${path}`;

      try {
        await fs.rm(localPath, { recursive: true, force: true });
        console.log(`Removed local directory: ${localPath}`);
        res.status(200).json({ success: true, path });
      } catch (error) {
        console.error("Error removing local directory:", error);
        res.status(500).send(`Internal server error: ${error}`);
      }

      return;
    }

    const filerUrl = getFilerUrl(true);

    const filerToken = njwt.create(
      {
        iss: "checkpoint-vcs",
        sub: "system",
        userId: "system",
        mode: "write",
        basePath: `/`,
      },
      config.get<string>("storage.jwt.signing-key"),
    );

    filerToken.setExpiration(Date.now() + 1000);

    try {
      const dirPath = path.endsWith("/") ? path : `${path}/`;
      const response = await fetch(`${filerUrl}${dirPath}?recursive=true`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${filerToken.compact()}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Failed to remove directory in SeaweedFS: ${errorText}`);
        res.status(500).send(`Failed to remove directory: ${errorText}`);
        return;
      }

      console.log(`Removed directory: ${path}`);
      res.status(200).json({ success: true, path });
    } catch (error) {
      console.error("Error removing directory in SeaweedFS:", error);
      res.status(500).send(`Internal server error: ${error}`);
    }
  });

  return router;
}
