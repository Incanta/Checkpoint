import type {
  QueryResolvers,
  MutationResolvers,
  FileLockRelationResolvers,
} from "types/graphql";

import { db } from "src/lib/db";
import { RedwoodUser } from "src/lib/auth";

export const fileLocks: QueryResolvers["fileLocks"] = async ({ repoId }, { context }) => {
  return db.fileLock.findMany();
};

export const lockFile: MutationResolvers["lockFile"] = async ({ fileId }, { context }) => {
  const file = await db.file.findUnique({
    where: { id: fileId },
    include: {
      repo: {
        include: {
          org: true,
          additionalRoles: true,
        },
      }
    }
  });

  if (!file) {
    return "File not found";
  }

  const currentUser: RedwoodUser = context.currentUser as RedwoodUser;

  if (file.repo.org.defaultRepoAccess === "NONE" || file.repo.org.defaultRepoAccess === "READ") {
    const repoRole = file.repo.additionalRoles.find((role) => role.userId === currentUser.id);

    if (!repoRole || repoRole.access === "NONE" || repoRole.access === "READ") {
      const orgUser = await db.orgUser.findFirst({
        where: {
          orgId: file.repo.org.id,
          userId: currentUser.id,
          role: "ADMIN"
        },
      });

      if (!orgUser) {
        return "Access denied";
      }
    }
  }

  const activeLock = await db.fileLock.findFirst({
    where: {
      fileId: fileId,
      unlockedAt: null,
    }
  });

  if (activeLock) {
    return "File already locked";
  }

  await db.fileLock.create({
    data: {
      fileId: fileId,
      userId: currentUser.id,
    },
  });

  return null;
};

export const unlockFile: MutationResolvers["lockFile"] = async ({ fileId }, { context }) => {
  const currentUser: RedwoodUser = context.currentUser as RedwoodUser;

  await db.fileLock.updateMany({
    data: {
      unlockedAt: new Date(),
    },
    where: {
      fileId: fileId,
      userId: currentUser.id,
      unlockedAt: null,
    }
  });

  return null;
};

export const FileLock: FileLockRelationResolvers = {
  file: (_obj, { root }) => {
    return db.fileLock.findUnique({ where: { id: root?.id } }).file();
  },
  user: (_obj, { root }) => {
    return db.fileLock.findUnique({ where: { id: root?.id } }).user();
  },
};
