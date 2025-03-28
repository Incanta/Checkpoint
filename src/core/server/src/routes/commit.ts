import type { Endpoint } from ".";
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
} from "@checkpointvcs/common";
import { ptr, toArrayBuffer } from "bun:ffi";

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
  message: string().required(),
  versionIndex: string().required(),
  modifications: array(
    object({
      delete: boolean().required(),
      path: string().required(),
      oldPath: string().optional(),
    }).required()
  ).required(),
});
interface RequestSchema extends InferType<typeof RequestSchema> {}

interface RequestResponse {}

export function routeCommit(): Record<string, Endpoint> {
  return {
    "/commit": {
      POST: async (request): Promise<typeof Response> => {
        const body = (await request.formData()) as any;

        const payload = JSON.parse(body.get("payload"));

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

        const additionalStoreIndex: Blob = body.get("storeIndex");

        if (!additionalStoreIndex) {
          return new Response("Store index required", { status: 400 });
        }

        const filerUrl = `http${
          config.get<boolean>("seaweedfs.connection.filer.tls") ? "s" : ""
        }://${config.get<string>(
          "seaweedfs.connection.filer.host"
        )}:${config.get<string>("seaweedfs.connection.filer.port")}`;

        const basePath = `/${claims.orgId}/${claims.repoId}`;

        const lib = CreateLongtailLibrary();

        const basePathBuffer = createStringBuffer(basePath);
        const filerUrlBuffer = createStringBuffer(filerUrl);
        const tokenBuffer = createStringBuffer(token);
        const storeIndexBuffer = await additionalStoreIndex.arrayBuffer();

        const asyncHandle = lib.MergeAsync(
          ptr(basePathBuffer.buffer),
          ptr(filerUrlBuffer.buffer),
          ptr(tokenBuffer.buffer),
          ptr(storeIndexBuffer),
          storeIndexBuffer.byteLength
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

        const responseMessage: RequestResponse = {};

        return new Response(JSON.stringify(responseMessage), { status: 200 });
      },
    },
  };
}
