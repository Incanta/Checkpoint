import {
  string,
  object,
  type InferType,
  ValidationError,
  array,
  boolean,
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

const upload = multer({ storage: multer.memoryStorage() });

const DIR_MODE_BIT = 0x80000000;

interface FilerChunk {
  file_id: string;
  size: number;
  mtime: number;
  e_tag: string;
}

interface FilerEntry {
  FullPath: string;
  Mode: number;
  chunks?: FilerChunk[];
}

interface FilerListResponse {
  Path: string;
  Entries: FilerEntry[] | null;
  Limit: number;
  LastFileName: string;
  ShouldDisplayLoadMore: boolean;
}

async function calculateRepoSize(
  filerUrl: string,
  basePath: string,
  authToken: string,
): Promise<number> {
  let totalSize = 0;
  const dirsToVisit: string[] = ["/"];

  while (dirsToVisit.length > 0) {
    const dir = dirsToVisit.pop()!;
    let lastFileName: string | undefined;
    let shouldLoadMore = true;

    while (shouldLoadMore) {
      const url = new URL(`${filerUrl}${basePath}${dir}`);
      if (lastFileName) {
        url.searchParams.set("lastFileName", lastFileName);
      }

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${authToken}`,
        },
      });

      if (!response.ok) {
        console.error(
          `Failed to list filer directory ${basePath}${dir}: ${response.status}`,
        );
        shouldLoadMore = false;
        break;
      }

      const data: FilerListResponse = await response.json();

      if (data.Entries) {
        for (const entry of data.Entries) {
          // Skip the size file itself
          if (entry.FullPath === `${basePath}/size`) {
            continue;
          }

          if ((entry.Mode & DIR_MODE_BIT) !== 0) {
            // Directory — recurse into it
            const relativePath = entry.FullPath.slice(basePath.length);
            dirsToVisit.push(`${relativePath}/`);
          } else if (entry.chunks) {
            // File — sum chunk sizes
            for (const chunk of entry.chunks) {
              totalSize += chunk.size;
            }
          }
        }
      }

      shouldLoadMore = data.ShouldDisplayLoadMore;
      lastFileName = data.LastFileName;
    }
  }

  return totalSize;
}

async function writeRepoSize(
  filerUrl: string,
  basePath: string,
  authToken: string,
  size: number,
): Promise<void> {
  const formData = new FormData();
  const file = new File([size.toString()], "size", { type: "text/plain" });
  formData.append("file", file);

  const response = await fetch(`${filerUrl}${basePath}/size`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
    },
    body: formData,
  });

  if (!response.ok) {
    console.error(
      `Failed to write repo size file: ${response.status} ${response.statusText}`,
    );
  }
}

export function routeSubmit(): Router {
  const router = Router();

  router.post("/submit", upload.single("storeIndex"), async (req, res) => {
    const payload: RequestSchema = JSON.parse(req.body.payload);

    try {
      await RequestSchema.validate(payload);
    } catch (e: any) {
      if (e instanceof ValidationError) {
        console.error(e.errors.join("\n"));
        res.status(500).send(e.errors.join("\n"));
        return;
      }
    }

    const authorizationHeader = req.headers["authorization"];
    if (!authorizationHeader) {
      res.status(401).send("Unauthorized");
      return;
    }

    const [type, token] = authorizationHeader.split(" ");

    if (type !== "Bearer") {
      console.error(2);
      res.status(401).send("Unauthorized");
      return;
    }

    const verifiedToken = jwt.verify(
      token,
      config.get("seaweedfs.jwt.signing-key"),
    );

    if (!verifiedToken) {
      console.error(3);
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

      const handle = mergeAsync({
        remoteBasePath: basePath,
        filerUrl,
        jwt: token,
        storeIndexBuffer: Buffer.from(storeIndexBuffer),
        logLevel,
      });

      if (!handle) {
        throw new Error("Failed to create longtail handle");
      }

      const { status } = await pollHandle(handle, {
        onStep: (step) => console.log(`Current step: ${step}`),
      });

      console.log(
        `Completed with exit code: ${status.error} and last step ${status.currentStep}`,
      );

      freeHandle(handle);
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
      config.get<string>("checkpoint.api.url"),
      payload.apiToken,
    );

    try {
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

      const responseMessage: RequestResponse = {
        id: createChangelistResponse.id,
        number: createChangelistResponse.number,
      };

      res.status(200).json(responseMessage);

      // Fire and forget — recalculate and persist total repo size
      const size = await calculateRepoSize(filerUrl, basePath, token);
      await writeRepoSize(filerUrl, basePath, token, size);
    } catch (e: any) {
      console.error(e.message);
      res.status(500).send(e.message);
    }
  });

  return router;
}
