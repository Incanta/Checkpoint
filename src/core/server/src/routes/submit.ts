import {
  string,
  object,
  type InferType,
  ValidationError,
  array,
  boolean,
  number,
} from "yup";
import { createHash } from "crypto";
import config from "@incanta/config";
import { CreateApiClientAuthManual } from "@checkpointvcs/common";
import {
  storeBlockMapAsync,
  pollHandle,
  freeHandle,
  GetLogLevel,
  type LongtailLogLevel,
} from "@checkpointvcs/longtail-addon";
import { Router, type RequestHandler } from "express";
import multer from "multer";
import { storeBlockMap } from "../storage/block-maps.js";
import { getStorageBackend } from "../storage/backend.js";
import {
  containmentProblem,
  readStoreIndexSummary,
} from "../storage/store-index-format.js";
import { writeSegment } from "../storage/index-segments.js";
import { verifyRepoToken, type RepoTokenResult } from "../utils/repo-token.js";
import { Logger } from "../logging.js";

// A version index is named after the SHA-256 of its bytes. The name is
// client-supplied and becomes part of a storage key, so anything else is
// refused rather than normalized, and the hash is recomputed here: a
// changelist must not record a name whose content is something else.
const VERSION_INDEX_NAME = /^([0-9a-f]{64})\.lvi$/;

/**
 * Confirms the version index a submit names is really in storage, intact.
 * Returns a message describing the problem, or null if the index is there.
 */
async function checkVersionIndex(
  repoId: string,
  basePath: string,
  versionIndex: string,
): Promise<string | null> {
  const expected = VERSION_INDEX_NAME.exec(versionIndex)?.[1];
  if (!expected) {
    return `Invalid version index name: ${versionIndex}. Update your Checkpoint client.`;
  }

  let size: number | null;
  let actual = "";
  try {
    // r2 mode keeps each repo in its own bucket; local and s3 ignore the option.
    const backend = await getStorageBackend({ bucket: `checkpoint-${repoId}` });
    const key = `${basePath}/versions/${versionIndex}`;
    size = await backend.head(key);
    if (size) {
      const stream = await backend.get(key);
      if (!stream) {
        size = null;
      } else {
        const hash = createHash("sha256");
        for await (const chunk of stream) {
          hash.update(chunk as Buffer);
        }
        actual = hash.digest("hex");
      }
    }
  } catch (e: any) {
    // Not being able to ask is not the same as the index being there.
    return `Could not confirm version index ${versionIndex} is in storage: ${e.message}`;
  }

  if (size === null) {
    return `Version index ${versionIndex} is not in storage. The upload did not complete; submit again.`;
  }
  if (size === 0) {
    return `Version index ${versionIndex} is empty in storage. The upload did not complete; submit again.`;
  }
  if (actual !== expected) {
    return `Version index ${versionIndex} does not match its name (content hashes to ${actual}). Refusing to record it.`;
  }
  return null;
}

const RequestSchema = object({
  apiToken: string().required(),
  branchName: string().required(),
  artifactForChangelistNum: number().optional(),
  message: string().required(),
  versionIndex: string().defined(),
  modifications: array(
    object({
      delete: boolean().required(),
      path: string().required(),
      oldPath: string().optional(),
      // The changelist the submitter's copy came from, or null for a file
      // that is new to the branch. Checked by the app against the branch head.
      baseChangelist: number().integer().min(0).nullable().optional(),
    }).required(),
  ).required(),
  keepCheckedOut: boolean().required(),
  workspaceId: string().required(),
  /** Storage protocol; 3 since store.lsi stopped being merged. */
  protocol: number().optional(),
  /** The client sends a base for every file it tracks (see createChangelist). */
  basesComplete: boolean().optional(),
});
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface RequestSchema extends InferType<typeof RequestSchema> {}

interface RequestResponse {
  id: string;
  number: number;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fieldSize: 200 * 1024 * 1024 },
});

export function routeSubmit(): Router {
  const router = Router();

  // A submit merges into the repo's store index before the app is asked to
  // create anything, so the storage token has to be a write token for this
  // repo in its own right. Checked before multer runs, so an unauthenticated
  // caller cannot make the server buffer an upload.
  const authenticate: RequestHandler = (req, res, next) => {
    const auth = verifyRepoToken(req.headers["authorization"], true);
    if (!auth.ok) {
      Logger.error(`[Submit] ${auth.message}`);
      res.status(auth.status).send(auth.message);
      return;
    }
    res.locals["repoToken"] = auth;
    next();
  };

  router.post(
    "/submit",
    authenticate,
    upload.fields([
      { name: "storeIndex", maxCount: 1 },
      { name: "blockMap", maxCount: 1 },
    ]),
    async (req, res) => {
      const parts = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
      const storeIndexFile = parts["storeIndex"]?.[0];
      const blockMapFile = parts["blockMap"]?.[0];
      Logger.debug(`[Submit] Received request`);

      const { claims, basePath } = res.locals["repoToken"] as Extract<
        RepoTokenResult,
        { ok: true }
      >;

      let payload: RequestSchema;
      try {
        payload = JSON.parse(req.body.payload);
        await RequestSchema.validate(payload);
      } catch (e: any) {
        const reason =
          e instanceof ValidationError
            ? e.errors.join("\n")
            : "Invalid payload";
        Logger.error(`[Submit] Invalid request shape: ${reason}`);
        res.status(400).send(reason);
        return;
      }

      // A client from before storage protocol 3 still expects the server to
      // merge its blocks into store.lsi, which no longer happens; recording
      // its changelist would leave its blocks out of the dedup index.
      if (payload.protocol !== 3) {
        res
          .status(426)
          .send(
            "This Checkpoint client is too old for this server (storage protocol 3). Update Checkpoint.",
          );
        return;
      }

      // New content bytes from this submit (set from the merge result below), used
      // to maintain the repo's cached storage size incrementally.
      let addedBytes = 0;

      // Where the server side of a submit spends its time, emitted as one
      // parseable line at the end. The index merge is the part expected to
      // grow with the repo rather than the change.
      const timing: Record<string, number> = {
        modifications: payload.modifications.length,
        storeIndexUploadBytes: storeIndexFile?.buffer?.length ?? 0,
        blockMapBytes: blockMapFile?.buffer?.length ?? 0,
      };
      const timed = async <T>(
        name: string,
        fn: () => Promise<T>,
      ): Promise<T> => {
        const start = Date.now();
        try {
          return await fn();
        } finally {
          timing[name] = (timing[name] ?? 0) + (Date.now() - start);
        }
      };
      const logTiming = () =>
        Logger.info(`[submit-server-timing] ${JSON.stringify(timing)}`);

      // The client uploads the version index to storage itself and only tells us
      // its name. Prove it arrived before anything records that name: a
      // changelist pointing at an index that is not there cannot be pulled, and
      // nothing downstream would notice until someone tried.
      if (payload.versionIndex) {
        const problem = await timed("versionIndexCheckMs", () =>
          checkVersionIndex(claims.repoId, basePath, payload.versionIndex),
        );
        if (problem) {
          Logger.error(`[Submit] ${problem}`);
          res.status(400).send(problem);
          return;
        }
      }

      // The version's block map lets readers find its blocks without the
      // repo-wide store index. Verified (it covers every chunk of the version
      // and every block it names exists) and stored before anything records
      // the changelist; a submit whose map does not check out is refused.
      if (blockMapFile?.buffer && payload.versionIndex) {
        const problem = await timed("blockMapMs", () =>
          storeBlockMap(
            claims.repoId,
            basePath,
            payload.versionIndex,
            Buffer.from(blockMapFile.buffer),
          ),
        );
        if (problem) {
          Logger.error(`[Submit] ${problem}`);
          res.status(400).send(problem);
          return;
        }
      }

      if (storeIndexFile) {
        const storeIndexBuffer = storeIndexFile.buffer;

        if (!storeIndexBuffer) {
          res.status(400).send("Store index required");
          return;
        }

        if (!payload.versionIndex) {
          res
            .status(400)
            .send(
              "Version index is required if you are uploading a store index",
            );
          return;
        }

        if (!blockMapFile?.buffer) {
          res
            .status(400)
            .send(
              "A block map is required with new content. Update your Checkpoint client.",
            );
          return;
        }

        // The uploaded store index names this submit's new blocks; it becomes
        // an index segment that later submits deduplicate against. It must be
        // contained in the block map verified above (whose every block was
        // proven to exist), or a client could get blocks into the shared
        // index that are not in the store, and every later submit reusing
        // them would come out unreadable.
        let missing;
        try {
          missing = readStoreIndexSummary(storeIndexBuffer);
          const map = readStoreIndexSummary(blockMapFile.buffer);
          const problem = containmentProblem(missing, map);
          if (problem) {
            res
              .status(400)
              .send(
                `The uploaded store index does not match the block map: ${problem}`,
              );
            return;
          }
        } catch (e: any) {
          res
            .status(400)
            .send(`The uploaded store index could not be read: ${e.message}`);
          return;
        }
        addedBytes = missing.chunkBytes;

        // Recorded with no lock: segments are write-once and named after
        // their content. This replaced reading, merging, and rewriting the
        // repo-wide store.lsi under a lock on every submit.
        try {
          await timed("segmentMs", async () => {
            const backend = await getStorageBackend({
              bucket: `checkpoint-${claims.repoId}`,
            });
            await writeSegment(
              backend,
              claims.repoId,
              basePath,
              Buffer.from(storeIndexBuffer),
              missing.blocks.size,
            );
          });
        } catch (e: any) {
          Logger.error(`[Submit] Could not write index segment: ${e.message}`);
          res.status(503).send(`Could not record the new blocks: ${e.message}`);
          return;
        }
      } else if (
        payload.modifications.some((m) => !m.delete) ||
        payload.versionIndex
      ) {
        res
          .status(400)
          .send(
            "The storeIndex multipart is required if you have any new/modified files.",
          );
        return;
      }

      const client = await CreateApiClientAuthManual(
        config.get<string>("checkpoint.api.url.internal"),
        payload.apiToken,
      );

      try {
        let responseMessage: RequestResponse;

        if (
          payload.artifactForChangelistNum != null &&
          payload.artifactForChangelistNum >= 0
        ) {
          Logger.debug(
            `[Submit] Routing to artifact attachment for changelist ${payload.artifactForChangelistNum}`,
          );

          // Route to artifact attachment on existing CL
          const artifactResponse =
            await client.artifact.attachToChangelist.mutate({
              repoId: claims.repoId,
              changelistNumber: payload.artifactForChangelistNum,
              versionIndex: payload.versionIndex,
              modifications: payload.modifications,
            });

          responseMessage = {
            id: String(artifactResponse.changelistNumber),
            number: artifactResponse.changelistNumber,
          };
        } else {
          Logger.debug(`[Submit] Routing to regular changelist creation`);

          const createChangelistResponse = await timed(
            "createChangelistMs",
            () =>
              client.changelist.createChangelist.mutate({
                message: payload.message,
                repoId: claims.repoId,
                versionIndex: payload.versionIndex,
                branchName: payload.branchName,
                modifications: payload.modifications,
                keepCheckedOut: payload.keepCheckedOut,
                workspaceId: payload.workspaceId,
                ...(payload.basesComplete === true && { basesComplete: true }),
              }),
          );

          responseMessage = {
            id: createChangelistResponse.id,
            number: createChangelistResponse.number,
          };
        }

        Logger.debug(
          `[Submit] Successfully processed submit request, responding with ${JSON.stringify(responseMessage)}`,
        );

        logTiming();
        res.status(200).json(responseMessage);

        // Maintain the repo's cached storage size incrementally
        // Fire-and-forget so it never delays the submit response.
        if (addedBytes > 0) {
          client.storage.incrementRepoStorageBytes
            .mutate({ repoId: claims.repoId, bytes: addedBytes })
            .catch((e: any) =>
              Logger.error(`[Submit] Failed to update repo size: ${e.message}`),
            );
        }
      } catch (e: any) {
        Logger.error(`[Submit] ${e.message}`);
        // The app refusing a submit (a stale file, someone else's claim) is
        // the caller's to fix, not a server fault; say which.
        const httpStatus = e?.data?.httpStatus;
        res
          .status(
            typeof httpStatus === "number" && httpStatus >= 400
              ? httpStatus
              : 500,
          )
          .send(e.message);
      }
    },
  );

  return router;
}
