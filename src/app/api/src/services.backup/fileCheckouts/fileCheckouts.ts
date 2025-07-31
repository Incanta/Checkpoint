import type {
  MutationResolvers,
} from "types/graphql";

import { db } from "src/lib/db";
import { RedwoodUser } from "src/lib/auth";

export const checkout: MutationResolvers["checkout"] = async ({ files, workspaceId }, { context }) => {
  const currentUser: RedwoodUser = context.currentUser as RedwoodUser;

  if (!currentUser) {
    throw new Error("User not authenticated");
  }

  const workspace = await db.workspace.findUnique({
    where: {
      id: workspaceId,
      userId: currentUser.id,
    },
    include: {
      repo: {
        include: {
          org: true,
          additionalRoles: true,
        },
      }
    },
  });

  if (!workspace) {
    throw new Error("Workspace not found");
  }

  if (workspace.repo.org.defaultRepoAccess === "NONE" || workspace.repo.org.defaultRepoAccess === "READ") {
    const repoRole = workspace.repo.additionalRoles.find((role) => role.userId === currentUser.id);

    if (!repoRole || repoRole.access === "NONE" || repoRole.access === "READ") {
      const orgUser = await db.orgUser.findFirst({
        where: {
          orgId: workspace.repo.org.id,
          userId: currentUser.id,
          role: "ADMIN"
        },
      });

      if (!orgUser) {
        throw new Error("Access denied");
      }
    }
  }

  const filesDb = await db.file.findMany({
    where: {
      id: {
        in: files.map((file) => file.fileId)
      },
      repoId: workspace.repoId,
    },
  });

  if (files.length !== filesDb.length) {
    throw new Error(`Files ${
      files.filter(f => !filesDb.some(fDb => fDb.id === f.fileId))
    } not found in repo ${workspace.repoId}`);
  }

  // make sure that we can lock (or already locked) the requested files with locked == true
  for (const file of filesDb) {
    const lockRequested = files.find((f) => f.fileId === file.id)?.locked || false;
    if (lockRequested) {
      const existingCheckoutWithLock = await db.fileCheckout.findFirst({
        where: {
          fileId: file.id,
          removedAt: null,
          locked: true,
          workspace: {
            userId: {
              not: currentUser.id,
            },
          }
        },
        include: {
          workspace: {
            include: {
              user: true,
            },
          },
        },
      });

      if (existingCheckoutWithLock) {
        throw new Error(`File ${file.path} is already locked by ${
          existingCheckoutWithLock.workspace.user.username
        } (${
          existingCheckoutWithLock.workspace.user.name
        } - ${existingCheckoutWithLock.workspace.user.email})`);
      }
    }
  }

  for (const file of filesDb) {
    const lockRequested = files.find((f) => f.fileId === file.id)?.locked || false;

    const existingCheckout = await db.fileCheckout.findFirst({
      where: {
        fileId: file.id,
        workspaceId: workspaceId,
        removedAt: null,
      },
    });

    if (existingCheckout && lockRequested !== existingCheckout.locked) {
      await db.fileCheckout.update({
        where: {
          id: existingCheckout.id,
        },
        data: {
          locked: lockRequested,
        },
      });
    } else if (!existingCheckout) {
      await db.fileCheckout.create({
        data: {
          fileId: file.id,
          workspaceId: workspaceId,
          locked: lockRequested,
        },
      });
    }
  }

  return true;
};
