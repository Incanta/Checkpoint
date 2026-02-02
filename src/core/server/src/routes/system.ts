import config from "@incanta/config";
import njwt from "njwt";
import type { BunRequest } from "bun";

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
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function routeSystem() {
  return {
    "/system/mkdir": {
      // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
      POST: async (request: BunRequest) => {
        // Verify system JWT
        const authorizationHeader = request.headers.toJSON()["authorization"];
        if (!authorizationHeader) {
          return new Response("Unauthorized: Missing authorization header", {
            status: 401,
          });
        }

        const [type, token] = authorizationHeader.split(" ");

        if (type !== "Bearer") {
          return new Response("Unauthorized: Invalid authorization type", {
            status: 401,
          });
        }

        let claims: SystemJWTClaims;
        try {
          const verifiedToken = njwt.verify(
            token,
            config.get<string>("seaweedfs.jwt.system-signing-key"),
          );

          if (!verifiedToken) {
            return new Response("Unauthorized: Invalid token", { status: 401 });
          }

          claims = verifiedToken.body.toJSON() as unknown as SystemJWTClaims;
        } catch (_error) {
          console.error("JWT verification failed:", _error);
          return new Response("Unauthorized: Token verification failed", {
            status: 401,
          });
        }

        // Verify this is a system token
        if (!claims.system || claims.iss !== "checkpoint-api") {
          return new Response("Forbidden: Not a system token", { status: 403 });
        }

        // Verify action
        if (claims.action !== "mkdir") {
          return new Response("Forbidden: Invalid action for this endpoint", {
            status: 403,
          });
        }

        // Parse request body
        let body: { path?: string };
        try {
          body = await request.json();
        } catch {
          return new Response("Bad Request: Invalid JSON body", {
            status: 400,
          });
        }

        const path = body.path;
        if (!path) {
          return new Response("Bad Request: Missing path", { status: 400 });
        }

        // Verify the path in the request matches the path in the token
        if (path !== claims.path) {
          return new Response("Forbidden: Path mismatch", { status: 403 });
        }

        // Validate path format (should be /orgId or /orgId/repoId)
        if (!path.match(/^\/[^/]+\/?$/) && !path.match(/^\/[^/]+\/[^/]+\/?$/)) {
          return new Response("Bad Request: Invalid path format", {
            status: 400,
          });
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
            console.error(
              `Failed to create directory in SeaweedFS: ${errorText}`,
            );
            return new Response(`Failed to create directory: ${errorText}`, {
              status: 500,
            });
          }

          console.log(`Created directory: ${path}`);
          return new Response(JSON.stringify({ success: true, path }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        } catch (error) {
          console.error("Error creating directory in SeaweedFS:", error);
          return new Response(`Internal server error: ${error}`, {
            status: 500,
          });
        }
      },
    },
  };
}
