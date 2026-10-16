import { Router, raw, type Request, type Response } from "express";
import njwt from "njwt";
import { getStorageBackend } from "../storage/backend.js";
import { storageSigningKey } from "../utils/signing-key.js";

// Content-addressed state-tree block storage. The app writes/reads tree blocks
// here over the system-JWT channel; the actual I/O goes through the unified
// storage backend (local / s3 / r2), the same path as longtail content blocks.
// Blocks live at /{orgId}/{repoId}/tree/{hash}.

interface SystemJWTClaims {
  iss: string;
  system: boolean;
  action: string;
  path: string;
}

// Max serialized block size (matches the app's BLOCK_BUDGET, with headroom).
const MAX_BLOCK_BYTES = 1024 * 1024;

/** Tree block paths: /{orgId}/{repoId}/tree/{64-hex-hash}. */
const BLOCK_PATH = /^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/tree\/[0-9a-f]{64}$/;
/** Version index paths: /{orgId}/{repoId}/versions/{64-hex-hash}.lvi. */
const VERSION_PATH =
  /^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/versions\/[0-9a-f]{64}\.lvi$/;

function verify(
  req: Request,
  res: Response,
  expectedAction: string,
  pathPattern: RegExp = BLOCK_PATH,
): SystemJWTClaims | null {
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
  let claims: SystemJWTClaims;
  try {
    const verified = njwt.verify(token, storageSigningKey());
    claims = verified!.body.toJSON() as unknown as SystemJWTClaims;
  } catch {
    res.status(401).send("Unauthorized: Token verification failed");
    return null;
  }
  if (!claims.system || claims.iss !== "checkpoint-api") {
    res.status(403).send("Forbidden: Not a system token");
    return null;
  }
  if (claims.action !== expectedAction) {
    res.status(403).send("Forbidden: Invalid action for this endpoint");
    return null;
  }
  const blockPath =
    (req.query["path"] as string | undefined) ??
    req.header("x-checkpoint-path");
  // Block paths are /{orgId}/{repoId}/tree/{64-hex-hash}.
  if (!blockPath || blockPath !== claims.path || !pathPattern.test(blockPath)) {
    res.status(403).send("Forbidden: Path mismatch or invalid");
    return null;
  }
  return claims;
}

async function writeBlob(
  blockPath: string,
  bucket: string | undefined,
  data: Buffer,
): Promise<void> {
  const backend = await getStorageBackend({ bucket });
  await backend.put(blockPath, data, data.length);
}

// Returns the block bytes, or null if it does not exist.
async function readBlob(
  blockPath: string,
  bucket: string | undefined,
): Promise<Buffer | null> {
  const backend = await getStorageBackend({ bucket });
  return backend.getBuffer(blockPath);
}

export function routeBlocks(): Router {
  const router = Router();

  router.put(
    "/system/blob",
    raw({ type: "application/octet-stream", limit: MAX_BLOCK_BYTES }),
    async (req, res) => {
      const claims = verify(req, res, "blob-put");
      if (!claims) return;
      const data = req.body as Buffer;
      if (!Buffer.isBuffer(data) || data.length === 0) {
        res.status(400).send("Bad Request: empty body");
        return;
      }
      try {
        await writeBlob(claims.path, req.header("x-checkpoint-bucket"), data);
        res.status(201).json({ success: true });
      } catch (error) {
        console.error("block write failed:", error);
        res.status(500).send(`Internal server error: ${error}`);
      }
    },
  );

  router.get("/system/blob", async (req, res) => {
    const claims = verify(req, res, "blob-get");
    if (!claims) return;
    try {
      const data = await readBlob(
        claims.path,
        req.header("x-checkpoint-bucket"),
      );
      if (!data) {
        res.status(404).send("Not Found");
        return;
      }
      res.status(200).type("application/octet-stream").send(data);
    } catch (error) {
      console.error("block read failed:", error);
      res.status(500).send(`Internal server error: ${error}`);
    }
  });

  // Whether a version index is in the repo's storage, for the app to check
  // before it records a changelist pointing at one (it refuses a changelist
  // whose content does not exist, whoever sends it). Answers rather than
  // 404s, so "missing" and "could not ask" stay distinct for the caller.
  router.get("/system/version-exists", async (req, res) => {
    const claims = verify(req, res, "version-head", VERSION_PATH);
    if (!claims) return;
    try {
      const backend = await getStorageBackend({
        bucket: req.header("x-checkpoint-bucket"),
      });
      const size = await backend.head(claims.path);
      res.status(200).json({ exists: !!size });
    } catch (error) {
      console.error("version check failed:", error);
      res.status(500).send(`Internal server error: ${error}`);
    }
  });

  return router;
}
