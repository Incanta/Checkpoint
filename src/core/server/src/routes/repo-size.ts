import { Router } from "express";
import jwt from "njwt";
import config from "@incanta/config";

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
      config.get("seaweedfs.jwt.signing-key"),
    );

    if (!verifiedToken) {
      res.status(401).send("Unauthorized");
      return;
    }

    const claims: JWTClaims = verifiedToken.body.toJSON() as any;

    const filerUrl = `http${
      config.get<boolean>("seaweedfs.connection.filer.tls") ? "s" : ""
    }://${config.get<string>(
      "seaweedfs.connection.filer.host",
    )}:${config.get<string>("seaweedfs.connection.filer.port")}`;

    const basePath = `/${claims.orgId}/${claims.repoId}`;

    try {
      const response = await fetch(`${filerUrl}${basePath}/size`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        // No size file yet — return 0
        res.status(200).json({ size: 0 });
        return;
      }

      const text = await response.text();
      const size = parseInt(text, 10);

      res.status(200).json({ size: isNaN(size) ? 0 : size });
    } catch (e: any) {
      console.error(`Failed to read repo size for ${basePath}:`, e.message);
      res.status(500).send(e.message);
    }
  });

  return router;
}
