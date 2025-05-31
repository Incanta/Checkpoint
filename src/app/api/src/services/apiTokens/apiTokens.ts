import type {
  QueryResolvers,
  ModificationInput,
  MutationResolvers,
} from "types/graphql";
import config from "@incanta/config";
import { v4 as uuidv4 } from "uuid";

import { db } from "src/lib/db";
import { RedwoodUser } from "src/lib/auth";
import { user } from "../users";

export const apiToken: QueryResolvers["apiToken"] = async ({ deviceCode }) => {
  const apiToken = await db.apiToken.findUnique({
    where: {
      deviceCode,
    },
  });

  if (apiToken) {
    await db.apiToken.update({
      where: {
        id: apiToken.id
      },
      data: {
        deviceCode: null,
      },
    });
  }

  return apiToken;
};


export const myApiTokens: QueryResolvers["myApiTokens"] = async ({}, { context }) => {
  const currentUser = context.currentUser as RedwoodUser;

  if (!currentUser) {
    throw new Error("You must be logged in to view your API tokens.");
  }

  const apiTokens = await db.apiToken.findMany({
    where: {
      userId: currentUser.id,
    },
  });

  return apiTokens.map((token) => {
    // Remove the token from the response
    return {
      ...token,
      token: null,
    };
  });
}

export const createApiToken: MutationResolvers["createApiToken"] = async ({ name, expiresAt, deviceCode }, { context }) => {
  const currentUser = context.currentUser as RedwoodUser;

  if (!currentUser) {
    throw new Error("You must be logged in to create an API token.");
  }


  const { SignJWT } = await import("jose");

  const claims = {
    type: "api-token",
    userId: currentUser.id,
    id: uuidv4(), // ensure random tokens
  };

  const signingKey = await config.getWithSecrets<string>("auth.api-tokens.signing-key");
  const secret = new TextEncoder().encode(signingKey);
  const algorithm = "HS256";
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: algorithm })
    .setIssuedAt()
    .setIssuer("urn:checkpointvcs:issuer")
    .setAudience("urn:checkpointvcs:audience")
    .sign(secret);

  const apiToken = await db.apiToken.create({
    data: {
      name,
      expiresAt,
      deviceCode,
      userId: currentUser.id,
      token,
    },
  });

  return apiToken;
}

export const deleteApiToken: MutationResolvers["deleteApiToken"] = async ({ id }, { context }) => {
  const currentUser = context.currentUser as RedwoodUser;

  if (!currentUser) {
    throw new Error("You must be logged in to delete an API token.");
  }

  await db.apiToken.delete({
    where: {
      id,
      userId: currentUser.id,
    },
  });

  return true;
}

export const renameApiToken: MutationResolvers["renameApiToken"] = async ({ id, name }, { context }) => {
  const currentUser = context.currentUser as RedwoodUser;

  if (!currentUser) {
    throw new Error("You must be logged in to rename an API token.");
  }

  const apiToken = await db.apiToken.update({
    where: {
      id,
      userId: currentUser.id,
    },
    data: {
      name,
    },
  });

  return apiToken;
}


