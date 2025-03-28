import type {
  QueryResolvers,
} from "types/graphql";
import config from "@incanta/config";
import jwt from "njwt";

import { db } from "src/lib/db";
import { RedwoodUser } from "src/lib/auth";

export const storageToken: QueryResolvers["storageToken"] = async ({ orgId, repoId, write }) => {
  const currentUser: RedwoodUser = context.currentUser as RedwoodUser;

  const createToken = () => {
    const token = jwt.create(
      {
        iss: "checkpoint-backend",
        sub: "checkpoint-storage",
        userId: currentUser.id,
        orgId,
        repoId,
        mode: write ? "write" : "read",
        basePath: `/`, // TODO: `/${orgId}/${repoId}`,
      },
      write ? config.get<string>("storage.signing-keys.write") : config.get<string>("storage.signing-keys.read")
    );

    const expirationMs = config.get<number>("storage.token-expiration") * 1000 + Date.now();
    token.setExpiration(new Date(expirationMs))

    const output = {
      token: token.compact(),
      expiration: Math.round(expirationMs / 1000),
      backendUrl: config.get<string>("storage.backend-url"),
    };

    return output;
  };

  const repo = await db.repo.findUnique({
    where: { id: repoId, orgId },
    include: {
      org: true,
    }
  });

  if (!repo) {
    return null;
  }

  if (repo.public && write === false) {
    return createToken();
  }

  const orgUser = await db.orgUser.findFirst({
    where: {
      orgId: repo.orgId,
      userId: currentUser.id,
    }
  });

  if (!orgUser) {
    return null;
  }

  if (repo.org.defaultRepoAccess !== "NONE" && write === false) {
    return createToken();
  }

  if (repo.org.defaultRepoAccess !== "NONE" && repo.org.defaultRepoAccess !== "READ" && write === true) {
    return createToken();
  }

  const repoRole = await db.repoRole.findFirst({
    where: {
      repoId: repo.id,
      userId: currentUser.id,
    },
  });

  if (!repoRole || repoRole.access === "NONE") {
    return null;
  }

  return createToken();
};
