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
  mergeAsync,
  pollHandle,
  freeHandle,
  GetLogLevel,
  type LongtailLogLevel,
} from "@checkpointvcs/longtail-addon";
import { Router, type RequestHandler } from "express";
import multer from "multer";
import { getR2Endpoint } from "../utils/r2.js";
import { getStorageBackend } from "../storage/backend.js";
import { withStoreIndexLock } from "../storage/index-lock.js";
import { verifyRepoToken, type RepoTokenResult } from "../utils/repo-token.js";
import { Logger } from "../logging.js";

// Build the backend storage descriptor the addon's server-side store.lsi merge
// needs, from the configured storage.mode. "local" merges against local disk;
// "s3" covers both s3 mode (shared bucket) and r2 mode (per-repo bucket), both
// via the addon's S3 adapter with the server's full credentials.
async function buildMergeStorageOptions(
  repoId: string,
): Promise<Record<string, unknown>> {
  const mode = config.get<string>("storage.mode");
  if (mode === "local") {
    return {
      storageType: "local",
      localStoragePath: config.get<string>("storage.local.path"),
    };
  }
  if (mode === "s3") {
    return {
      storageType: "s3",
      s3Endpoint: config.get<string>("storage.s3.endpoint"),
      s3Region: config.get<string>("storage.s3.region"),
      s3Bucket: config.get<string>("storage.s3.bucket"),
      s3ForcePathStyle: config.get<boolean>("storage.s3.force-path-style"),
      s3AccessKeyId: await config.getWithSecrets<string>(
        "storage.s3.access-key-id",
      ),
      s3SecretAccessKey: await config.getWithSecrets<string>(
        "storage.s3.secret-access-key",
      ),
    };
  }
  // r2: the addon's S3 adapter pointed at R2, per-repo bucket.
  return {
    storageType: "s3",
    s3Endpoint: getR2Endpoint(),
    s3Region: "auto",
    s3Bucket: `checkpoint-${repoId}`,
    s3ForcePathStyle: false,
    s3AccessKeyId: await config.getWithSecrets<string>(
      "storage.r2.access-key-id",
    ),
    s3SecretAccessKey: await config.getWithSecrets<string>(
      "storage.r2.secret-access-key",
    ),
  };
}

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
    upload.single("storeIndex"),
    async (req, res) => {
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

      // New content bytes from this submit (set from the merge result below), used
      // to maintain the repo's cached storage size incrementally.
      let addedBytes = 0;

      // The client uploads the version index to storage itself and only tells us
      // its name. Prove it arrived before anything records that name: a
      // changelist pointing at an index that is not there cannot be pulled, and
      // nothing downstream would notice until someone tried.
      if (payload.versionIndex) {
        const problem = await checkVersionIndex(
          claims.repoId,
          basePath,
          payload.versionIndex,
        );
        if (problem) {
          Logger.error(`[Submit] ${problem}`);
          res.status(400).send(problem);
          return;
        }
      }

      if (req.file) {
        const storeIndexBuffer = req.file.buffer;

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

        const logLevel = GetLogLevel(
          config.get<LongtailLogLevel>("longtail.log-level"),
        );

        const mergeOptions = {
          remoteBasePath: basePath,
          storeIndexBuffer: Buffer.from(storeIndexBuffer),
          logLevel,
          ...(await buildMergeStorageOptions(claims.repoId)),
        } as Parameters<typeof mergeAsync>[0];

        Logger.debug(
          `[Submit] Merging store index (mode ${config.get<string>("storage.mode")})`,
        );

        // The merge reads the repo's store index, adds this submit's blocks,
        // and writes it back. Two of those interleaved would drop one side's
        // blocks from the index, so it runs under the repo's index lock.
        let merged: Awaited<ReturnType<typeof pollHandle>>;
        try {
          const lockBackend = await getStorageBackend({
            bucket: `checkpoint-${claims.repoId}`,
          });
          merged = await withStoreIndexLock(lockBackend, basePath, async () => {
            const handle = mergeAsync(mergeOptions);

            if (!handle) {
              throw new Error("Failed to create longtail handle");
            }

            try {
              return await pollHandle(handle, {
                onStep: (step) =>
                  Logger.debug(`[Submit] Current step: ${step}`),
              });
            } finally {
              freeHandle(handle);
            }
          });
        } catch (e: any) {
          Logger.error(`[Submit] Store index merge did not run: ${e.message}`);
          res
            .status(503)
            .send(`Could not update the store index: ${e.message}`);
          return;
        }
        const { status, result } = merged;

        Logger.debug(
          `[Submit] Completed with exit code: ${status.error} and last step ${status.currentStep}`,
        );

        if (status.error !== 0) {
          res
            .status(500)
            .send(
              `Failed to merge store indexes: ${status.currentStep} (error ${status.error})`,
            );
          return;
        }

        // The merge reports the new content bytes from this submit's store index.
        addedBytes = Number(
          (result as { addedBytes?: number })?.addedBytes ?? 0,
        );
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

          const createChangelistResponse =
            await client.changelist.createChangelist.mutate({
              message: payload.message,
              repoId: claims.repoId,
              versionIndex: payload.versionIndex,
              branchName: payload.branchName,
              modifications: payload.modifications,
              keepCheckedOut: payload.keepCheckedOut,
              workspaceId: payload.workspaceId,
            });

          responseMessage = {
            id: createChangelistResponse.id,
            number: createChangelistResponse.number,
          };
        }

        Logger.debug(
          `[Submit] Successfully processed submit request, responding with ${JSON.stringify(responseMessage)}`,
        );

        Logger.debug(
          `[Submit] Successfully processed submit request, responding with ${JSON.stringify(responseMessage)}`,
        );

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
