import { Router, type Request, type Response } from "express";
import config from "@incanta/config";
import njwt from "njwt";
import { createHash } from "crypto";
import { Transform } from "stream";
import { getStorageBackend } from "../storage/backend.js";
import { Logger } from "../logging.js";

// Checkpoint storage gateway: the client-facing blob data plane for the
// "local" and "s3" storage modes. The client talks here with its scoped
// Checkpoint JWT; the server holds the backend credentials and streams to/from
// local disk or an S3-compatible store. R2 mode does NOT use this (the client
// talks to R2 directly), so the router is only mounted for gateway modes.
//
// Protocol (see STORAGE.md): HEAD/GET/PUT/DELETE /{org}/{repo}/{key}.
// Auth: Authorization: Bearer <Checkpoint JWT>. The request path must be under
// the token's basePath; mutating methods require mode "write". Streaming, no
// whole-object buffering. PUT is atomic (overwrite).
//
// Version indexes are the exception to "overwrite": they are write-once and
// content addressed. See versionIndexName below.

interface UserJWTClaims {
  iss: string;
  userId: string;
  orgId: string;
  repoId: string;
  mode: "read" | "write";
  basePath: string;
}

function verify(req: Request, res: Response): UserJWTClaims | null {
  const header = req.headers["authorization"];
  if (!header) {
    res.status(401).send("Unauthorized: Missing authorization header");
    return null;
  }
  const [type, token] = header.split(" ");
  if (type !== "Bearer" || !token) {
    res.status(401).send("Unauthorized: Invalid authorization type");
    return null;
  }

  let claims: UserJWTClaims;
  try {
    const verified = njwt.verify(
      token,
      config.get<string>("storage.jwt.signing-key"),
    );
    claims = verified!.body.toJSON() as unknown as UserJWTClaims;
  } catch {
    res.status(401).send("Unauthorized: Token verification failed");
    return null;
  }

  if (claims.iss !== "checkpoint-vcs") {
    res.status(403).send("Forbidden: Wrong token issuer");
    return null;
  }
  if (claims.mode !== "read" && claims.mode !== "write") {
    res.status(403).send("Forbidden: Invalid token mode");
    return null;
  }

  // The request path (relative to this router's mount) must be under basePath.
  const reqPath = decodeURIComponent(req.path);
  if (reqPath !== claims.basePath && !reqPath.startsWith(claims.basePath + "/")) {
    res.status(403).send("Forbidden: Path outside token scope");
    return null;
  }

  const mutating =
    req.method === "PUT" || req.method === "POST" || req.method === "DELETE";
  if (mutating && claims.mode !== "write") {
    res.status(403).send("Forbidden: Write permission required");
    return null;
  }

  return claims;
}

// A changelist records the name of its version index and nothing else about
// it, so whatever sits under that name IS the changelist's content. These keys
// are therefore write-once: the name must be the SHA-256 of the body, an
// existing index is never replaced, and clients cannot delete one.
const VERSION_INDEX_KEY = /^\/[^/]+\/[^/]+\/versions\/([^/]+)$/;
const CONTENT_NAME = /^([0-9a-f]{64})\.lvi$/;

/** The file name if the key is a repo's version index, otherwise null. */
function versionIndexName(key: string): string | null {
  return VERSION_INDEX_KEY.exec(key)?.[1] ?? null;
}

export function routeGateway(): Router {
  const router = Router();

  router.head("/*splat", async (req, res) => {
    if (!verify(req, res)) return;
    try {
      const backend = await getStorageBackend();
      const size = await backend.head(decodeURIComponent(req.path));
      if (size === null) {
        res.status(404).end();
        return;
      }
      res.set("Content-Length", String(size));
      res.status(200).end();
    } catch (err) {
      Logger.error(`gateway HEAD failed: ${err}`);
      res.status(500).end();
    }
  });

  router.get("/*splat", async (req, res) => {
    if (!verify(req, res)) return;
    try {
      const backend = await getStorageBackend();
      const key = decodeURIComponent(req.path);
      const size = await backend.head(key);
      if (size === null) {
        res.status(404).send("Not found");
        return;
      }
      const stream = await backend.get(key);
      if (!stream) {
        res.status(404).send("Not found");
        return;
      }
      res.set("Content-Length", String(size));
      res.status(200).type("application/octet-stream");
      stream.on("error", (err) => {
        Logger.error(`gateway GET stream error: ${err}`);
        if (!res.headersSent) res.status(500).end();
        else res.destroy();
      });
      res.on("close", () => stream.destroy());
      stream.pipe(res);
    } catch (err) {
      Logger.error(`gateway GET failed: ${err}`);
      if (!res.headersSent) res.status(500).send("Internal server error");
    }
  });

  router.put("/*splat", async (req, res) => {
    if (!verify(req, res)) return;
    const lengthHeader = req.headers["content-length"];
    if (!lengthHeader) {
      res.status(411).send("Length Required");
      return;
    }
    const contentLength = parseInt(lengthHeader, 10);
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      res.status(400).send("Bad Request: invalid Content-Length");
      return;
    }
    try {
      const backend = await getStorageBackend();
      const key = decodeURIComponent(req.path);
      const indexName = versionIndexName(key);

      if (indexName !== null) {
        const expected = CONTENT_NAME.exec(indexName)?.[1];
        if (!expected) {
          res
            .status(400)
            .send("Bad Request: a version index must be named <sha256>.lvi");
          return;
        }

        // Already stored: the name is the hash of the content, so this is the
        // same index (a retry, or an identical submit). Accept without
        // rewriting it.
        if ((await backend.head(key)) !== null) {
          req.resume();
          res.status(200).json({ success: true, existing: true });
          return;
        }

        const hash = createHash("sha256");
        const hashing = new Transform({
          transform(chunk, _encoding, callback) {
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        req.on("error", (err) => hashing.destroy(err));
        await backend.put(key, req.pipe(hashing), contentLength);

        if (hash.digest("hex") !== expected) {
          await backend.delete(key);
          res
            .status(400)
            .send("Bad Request: version index content does not match its name");
          return;
        }
        res.status(201).json({ success: true });
        return;
      }

      // req is the raw body stream (express.json only consumes application/json).
      await backend.put(key, req, contentLength);
      res.status(201).json({ success: true });
    } catch (err) {
      Logger.error(`gateway PUT failed: ${err}`);
      res.status(500).send("Internal server error");
    }
  });

  router.delete("/*splat", async (req, res) => {
    if (!verify(req, res)) return;
    try {
      const key = decodeURIComponent(req.path);
      if (versionIndexName(key) !== null) {
        res.status(403).send("Forbidden: version indexes cannot be deleted");
        return;
      }
      const backend = await getStorageBackend();
      await backend.delete(key);
      res.status(204).end();
    } catch (err) {
      Logger.error(`gateway DELETE failed: ${err}`);
      res.status(500).send("Internal server error");
    }
  });

  return router;
}
