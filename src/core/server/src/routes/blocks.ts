import { Router, raw, type Request, type Response } from "express";
import config from "@incanta/config";
import njwt from "njwt";
import { promises as fs } from "fs";
import path from "path";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getR2Client } from "../utils/r2.js";
import { getFilerUrl } from "../utils/filer.js";

// Content-addressed state-tree block storage. The API server writes/reads tree
// blocks here over the system-JWT channel; this route routes the actual I/O to
// R2, the SeaweedFS filer, or the local stub by storage.mode. Blocks live at
// /{orgId}/{repoId}/tree/{hash}, alongside longtail content.

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

function stubEnabled(): boolean {
  return (
    config.get<string>("storage.mode") === "seaweedfs" &&
    config.get<boolean>("storage.seaweedfs.stub.enabled")
  );
}

function filerSystemToken(): string {
  const token = njwt.create(
    {
      iss: "checkpoint-vcs",
      sub: "system",
      userId: "system",
      mode: "write",
      basePath: "/",
    },
    config.get<string>("storage.jwt.signing-key"),
  );
  token.setExpiration(Date.now() + 60_000);
  return token.compact();
}

async function writeBlob(
  blockPath: string,
  bucket: string | undefined,
  data: Buffer,
): Promise<void> {
  if (stubEnabled()) {
    const local = `${config.get<string>("storage.seaweedfs.stub.storage-path")}${blockPath}`;
    await fs.mkdir(path.dirname(local), { recursive: true });
    await fs.writeFile(local, data);
    return;
  }
  if (config.get<string>("storage.mode") === "r2") {
    if (!bucket) throw new Error("missing bucket for r2 block write");
    const s3 = await getR2Client();
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: blockPath.replace(/^\//, ""),
        Body: data,
      }),
    );
    return;
  }
  // SeaweedFS filer: multipart upload to the full path.
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(data)]), path.basename(blockPath));
  const response = await fetch(`${getFilerUrl(true)}${blockPath}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${filerSystemToken()}` },
    body: form,
  });
  if (!response.ok) {
    throw new Error(
      `filer block write failed ${response.status}: ${await response.text()}`,
    );
  }
}

// Returns the block bytes, or null if it does not exist.
async function readBlob(
  blockPath: string,
  bucket: string | undefined,
): Promise<Buffer | null> {
  if (stubEnabled()) {
    const local = `${config.get<string>("storage.seaweedfs.stub.storage-path")}${blockPath}`;
    try {
      return await fs.readFile(local);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
  if (config.get<string>("storage.mode") === "r2") {
    if (!bucket) throw new Error("missing bucket for r2 block read");
    const s3 = await getR2Client();
    try {
      const out = await s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: blockPath.replace(/^\//, ""),
        }),
      );
      const bytes = await out.Body!.transformToByteArray();
      return Buffer.from(bytes);
    } catch (err) {
      if ((err as { name?: string }).name === "NoSuchKey") return null;
      throw err;
    }
  }
  // SeaweedFS filer.
  const response = await fetch(`${getFilerUrl(true)}${blockPath}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${filerSystemToken()}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`filer block read failed ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
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
