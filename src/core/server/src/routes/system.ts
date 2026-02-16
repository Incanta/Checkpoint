import { Router } from "express";
import config from "@incanta/config";
import njwt from "njwt";

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
        config.get<string>("seaweedfs.jwt.system-signing-key"),
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

    // Create directory in SeaweedFS filer
    const filerUrl = `http${
      config.get<boolean>("seaweedfs.connection.filer.tls") ? "s" : ""
    }://${config.get<string>(
      "seaweedfs.connection.filer.host",
    )}:${config.get<string>("seaweedfs.connection.filer.port")}`;

    const filerToken = njwt.create(
      {
        iss: "checkpoint-vcs",
        sub: "system",
        userId: "system",
        mode: "write",
        basePath: `/`,
      },
      config.get<string>("seaweedfs.jwt.signing-key"),
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

  return router;
}
