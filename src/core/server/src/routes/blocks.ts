import { Router, raw, type Request, type Response } from "express";
import config from "@incanta/config";
import njwt from "njwt";
import { getStorageBackend } from "../storage/backend.js";

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

function verify(
  req: Request,
  res: Response,
  expectedAction: string,
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
    const verified = njwt.verify(
      token,
      config.get<string>("storage.jwt.signing-key"),
    );
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
    (req.query["path"] as string | undefined) ?? req.header("x-checkpoint-path");
  // Block paths are /{orgId}/{repoId}/tree/{64-hex-hash}.
  if (
    !blockPath ||
    blockPath !== claims.path ||
    !/^\/[^/]+\/[^/]+\/tree\/[0-9a-f]{64}$/.test(blockPath)
  ) {
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
      const data = await readBlob(claims.path, req.header("x-checkpoint-bucket"));
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

  return router;
}
