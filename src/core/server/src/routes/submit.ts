import {
  string,
  object,
  type InferType,
  ValidationError,
  array,
  boolean,
  number,
} from "yup";
import jwt from "njwt";
import config from "@incanta/config";
import { CreateApiClientAuthManual } from "@checkpointvcs/common";
import {
  mergeAsync,
  pollHandle,
  freeHandle,
  GetLogLevel,
  type LongtailLogLevel,
} from "@checkpointvcs/longtail-addon";
import { Router } from "express";
import multer from "multer";
import { getR2Endpoint } from "../utils/r2.js";
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

interface JWTClaims {
  iss: string;
  sub: string;
  userId: string;
  orgId: string;
  repoId: string;
  mode: string;
  basePath: string;
}

const RequestSchema = object({
  apiToken: string().required(),
  branchName: string().required(),
  shelfName: string().optional(),
  artifactForChangelistNum: number().optional(),
  message: string().required(),
  versionIndex: string().defined(),
  modifications: array(
    object({
      delete: boolean().required(),
      path: string().required(),
      oldPath: string().optional(),
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

  router.post("/submit", upload.single("storeIndex"), async (req, res) => {
    Logger.debug(`[Submit] Received request`);

    const payload: RequestSchema = JSON.parse(req.body.payload);

    try {
      await RequestSchema.validate(payload);
    } catch (e: any) {
      if (e instanceof ValidationError) {
        Logger.error(`[Submit] Invalid request shape: ${e.errors.join("\n")}`);
        res.status(500).send(e.errors.join("\n"));
        return;
      }
    }

    const authorizationHeader = req.headers["authorization"];
    if (!authorizationHeader) {
      Logger.error("[Submit] Missing Authorization header");
      res.status(401).send("Unauthorized");
      return;
    }

    const [type, token] = authorizationHeader.split(" ");

    if (type !== "Bearer") {
      Logger.error("[Submit] Invalid Authorization header type");
      res.status(401).send("Unauthorized");
      return;
    }

    const verifiedToken = jwt.verify(
      token,
      config.get("storage.jwt.signing-key"),
    );

    if (!verifiedToken) {
      Logger.error("[Submit] Invalid token");
      res.status(401).send("Unauthorized");
      return;
    }

    const claims: JWTClaims = verifiedToken.body.toJSON() as any;

    const basePath = `/${claims.orgId}/${claims.repoId}`;

    // New content bytes from this submit (set from the merge result below), used
    // to maintain the repo's cached storage size incrementally.
    let addedBytes = 0;

    if (req.file) {
      const storeIndexBuffer = req.file.buffer;

      if (!storeIndexBuffer) {
        res.status(400).send("Store index required");
        return;
      }

      if (!payload.versionIndex) {
        res
          .status(400)
          .send("Version index is required if you are uploading a store index");
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

      const handle = mergeAsync(mergeOptions);

      if (!handle) {
        throw new Error("Failed to create longtail handle");
      }

      const { status, result } = await pollHandle(handle, {
        onStep: (step) => Logger.debug(`[Submit] Current step: ${step}`),
      });

      Logger.debug(
        `[Submit] Completed with exit code: ${status.error} and last step ${status.currentStep}`,
      );

      freeHandle(handle);

      if (status.error !== 0) {
        res
          .status(500)
          .send(
            `Failed to merge store indexes: ${status.currentStep} (error ${status.error})`,
          );
        return;
      }

      // The merge reports the new content bytes from this submit's store index.
      addedBytes = Number((result as { addedBytes?: number })?.addedBytes ?? 0);
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

      if (payload.shelfName) {
        Logger.debug(
          `[Submit] Routing to shelf creation with name ${payload.shelfName}`,
        );

        // Route to shelf creation instead of branch changelist
        const shelfResponse = await client.shelf.createFromSubmit.mutate({
          repoId: claims.repoId,
          shelfName: payload.shelfName,
          description: "",
          versionIndex: payload.versionIndex,
          message: payload.message,
          modifications: payload.modifications,
        });

        responseMessage = {
          id: shelfResponse.shelfName,
          number: shelfResponse.changelistNumber,
        };
      } else if (
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
      res.status(500).send(e.message);
    }
  });

  return router;
}
