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
import {
  CreateLongtailLibrary,
  createStringBuffer,
  decodeHandle,
  GetLogLevel,
  type LongtailLogLevel,
  CreateApiClient
} from "@checkpointvcs/common";
import { ptr, toArrayBuffer } from "bun:ffi";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@checkpointvcs/app";
import superjson from "superjson";
import type { BunRequest } from "bun";

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
    }).required()
  ).required(),
  keepCheckedOut: boolean().required(),
  workspaceId: string().required(),
});
interface RequestSchema extends InferType<typeof RequestSchema> {}

interface RequestResponse {
  id: string;
  number: number;
}

export function routeSubmit() {
  return {
    "/submit": {
      POST: async (request: BunRequest) => {
        const body = (await request.formData()) as any;

        const payload: RequestSchema = JSON.parse(body.get("payload"));

        try {
          await RequestSchema.validate(payload);
        } catch (e: any) {
          if (e instanceof ValidationError) {
            console.error(e.errors.join("\n"));
            return new Response(e.errors.join("\n"), { status: 500 });
          }
        }

        const authorizationHeader = request.headers.toJSON()["authorization"];
        if (!authorizationHeader) {
          return new Response("Unauthorized", { status: 401 });
        }

        const [type, token] = authorizationHeader.split(" ");

        if (type !== "Bearer") {
          console.error(2);
          return new Response("Unauthorized", { status: 401 });
        }

        const verifiedToken = jwt.verify(
          token,
          config.get("seaweedfs.jwt.signing-key")
        );

        if (!verifiedToken) {
          console.error(3);
          return new Response("Unauthorized", { status: 401 });
        }

        const claims: JWTClaims = verifiedToken.body.toJSON() as any;

        if (body.has("storeIndex")) {
          const additionalStoreIndex: Blob = body.get("storeIndex");

          if (!additionalStoreIndex) {
            return new Response("Store index required", { status: 400 });
          }

          if (!payload.versionIndex) {
            return new Response(
              "Version index is required if you are uploading a store index",
              { status: 400 }
            );
          }

          const filerUrl = `http${
            config.get<boolean>("seaweedfs.connection.filer.tls") ? "s" : ""
          }://${config.get<string>(
            "seaweedfs.connection.filer.host"
          )}:${config.get<string>("seaweedfs.connection.filer.port")}`;

          const basePath = `/${claims.orgId}/${claims.repoId}`;

          const lib = CreateLongtailLibrary();
          const logLevel = GetLogLevel(
            config.get<LongtailLogLevel>("longtail.log-level")
          );

          const basePathBuffer = createStringBuffer(basePath);
          const filerUrlBuffer = createStringBuffer(filerUrl);
          const tokenBuffer = createStringBuffer(token);
          const storeIndexBuffer = await additionalStoreIndex.arrayBuffer();

          const asyncHandle = lib.MergeAsync(
            ptr(basePathBuffer.buffer),
            ptr(filerUrlBuffer.buffer),
            ptr(tokenBuffer.buffer),
            ptr(storeIndexBuffer),
            storeIndexBuffer.byteLength,
            logLevel
          );

          if (asyncHandle === 0 || asyncHandle === null) {
            throw new Error("Failed to create longtail handle");
          }

          let flagForGC = true;
          let lastStep = "";

          // eslint-disable-next-line no-constant-condition
          while (true) {
            const decoded = decodeHandle(
              new Uint8Array(toArrayBuffer(asyncHandle, 0, 272))
            );

            if (decoded.currentStep !== lastStep) {
              console.log(`Current step: ${decoded.currentStep}`);
              lastStep = decoded.currentStep;
            }

            if (decoded.completed) {
              console.log(
                `Completed with exit code: ${decoded.error} and last step ${decoded.currentStep}`
              );
              flagForGC = false;
              break;
            }

            await new Promise<void>((resolve) => setTimeout(resolve, 10));
          }

          if (flagForGC) {
            console.log(basePathBuffer);
            console.log(filerUrlBuffer);
            console.log(tokenBuffer);
            console.log(storeIndexBuffer);
          }

          lib.FreeHandle(asyncHandle);
        } else if (
          payload.modifications.some((m) => !m.delete) ||
          payload.versionIndex
        ) {
          return new Response(
            "The storeIndex multipart is required if you have any new/modified files.",
            { status: 400 }
          );
        }

        const client = CreateApiClient();

        try {
          const createChangelistResponse = await client.changelist.createChangelist.mutate({
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

          return new Response(JSON.stringify(responseMessage), { status: 200 });
        } catch (e: any) {
          console.error(e.message);
          return new Response(e.message, { status: 500 });
        }
      },
    },
  };
}
