import express, { Router } from "express";
import { getStorageBackend } from "../storage/backend.js";
import { existingContent } from "../storage/index-segments.js";
import { verifyRepoToken } from "../utils/repo-token.js";
import { Logger } from "../logging.js";

// POST /existing-content: which of a submit's chunks the store already has.
//
// Body (application/octet-stream, little-endian):
//   "CPEC"            magic
//   u32 format        1
//   u32 hash id       the submit's hashing algorithm (informational)
//   u32 min usage     MinBlockUsagePercent
//   u32 n             chunk count
//   u64[n]            chunk hashes
//
// Response: a serialized store index of the blocks to reuse, with
// X-Checkpoint-Index: complete | partial. "partial" means the server's index
// was not ready and the answer is empty, so the client uploads its whole
// change; it is never wrong, only wasteful.
//
// This replaces the client downloading the repo-wide store.lsi to work this
// out itself.

const MAGIC = "CPEC";
const HEADER = 20;
// About 64 MB of hashes. A larger submit asks in parts.
const MAX_CHUNKS = 8 * 1024 * 1024;

/** A serialized store index with no blocks (Longtail format 1.0.0). */
export function emptyStoreIndex(): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt32LE(1 << 24, 0);
  return b;
}

export function routeExistingContent(): Router {
  const router = Router();

  router.post(
    "/existing-content",
    (req, res, next) => {
      const auth = verifyRepoToken(req.headers["authorization"], true);
      if (!auth.ok) {
        res.status(auth.status).send(auth.message);
        return;
      }
      res.locals["repoToken"] = auth;
      next();
    },
    express.raw({ type: "*/*", limit: HEADER + MAX_CHUNKS * 8 }),
    async (req, res) => {
      const started = Date.now();
      const { claims, basePath } = res.locals["repoToken"] as {
        claims: { repoId: string };
        basePath: string;
      };
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length < HEADER || body.toString("latin1", 0, 4) !== MAGIC) {
        res.status(400).send("Malformed existing-content request");
        return;
      }
      const format = body.readUInt32LE(4);
      const minUsage = body.readUInt32LE(12);
      const count = body.readUInt32LE(16);
      if (format !== 1 || count > MAX_CHUNKS || body.length !== HEADER + count * 8) {
        res.status(400).send("Malformed existing-content request");
        return;
      }

      try {
        const backend = await getStorageBackend({ bucket: `checkpoint-${claims.repoId}` });
        const answer = await existingContent(
          backend,
          claims.repoId,
          basePath,
          body.subarray(HEADER),
          minUsage,
          { emptyIndex: emptyStoreIndex },
        );
        Logger.info(
          `[existing-content] ${JSON.stringify({
            repoId: claims.repoId,
            chunks: count,
            complete: answer.complete,
            answerBytes: answer.storeIndex.length,
            ms: Date.now() - started,
          })}`,
        );
        res
          .status(200)
          .setHeader("X-Checkpoint-Index", answer.complete ? "complete" : "partial")
          .type("application/octet-stream")
          .send(answer.storeIndex);
      } catch (e) {
        Logger.error(`[existing-content] ${(e as Error).message}`);
        res.status(503).send(`Could not answer existing-content: ${(e as Error).message}`);
      }
    },
  );

  return router;
}
