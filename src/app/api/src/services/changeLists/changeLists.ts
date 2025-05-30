import type {
  QueryResolvers,
  MutationResolvers,
  ChangelistRelationResolvers,
  ModificationInput,
} from "types/graphql";

import { db } from "src/lib/db";
import { RedwoodUser } from "src/lib/auth";
import { FileChangeType } from "@prisma/client";

interface DbModification extends ModificationInput {
  id: string;
  isNew: boolean;
}

export const changelist: QueryResolvers["changelist"] = ({ id }) => {
  return db.changelist.findUnique({
    where: { id },
  });
};

export const changelists: QueryResolvers["changelists"] = ({ repoId, numbers }) => {
  return db.changelist.findMany({
    where: {
      repoId,
      number: {
        in: numbers,
      },
     },
  });
};

export const createChangelist: MutationResolvers["createChangelist"] = async ({
  input,
}, { context }) => {
  const repo = await db.repo.findUnique({
    where: { id: input.repoId },
    include: {
      org: true,
    }
  });

  if (!repo) {
    throw new Error(`Repo ${input.repoId} not found`);
  }

  const orgUser = await db.orgUser.findFirst({
    where: {
      orgId: repo.orgId,
      userId: (context.currentUser as RedwoodUser).id,
    }
  });

  if (!orgUser) {
    throw new Error(`User is not in the repo's org`);
  }

  const currentUser: RedwoodUser = context.currentUser as RedwoodUser;

  if (repo.org.defaultRepoAccess === "NONE" || repo.org.defaultRepoAccess === "READ") {
    const repoRole = await db.repoRole.findFirst({
      where: {
        repoId: repo.id,
        userId: currentUser.id,
      },
    });

    if (!repoRole || repoRole.access === "NONE" || repoRole.access === "READ") {
      throw new Error(`User does not have write access to repo`);
    }
  }

  const dbModifications: DbModification[] = await Promise.all(
    input.modifications.map(async (modification) => {
      let dbFile = await db.file.findFirst({
        where: {
          repoId: input.repoId,
          path: modification.oldPath || modification.path,
        },
        orderBy: {
          createdAt: "desc",
        },
      });

      let isNew = false;
      if (!dbFile) {
        dbFile = await db.file.create({
          data: {
            repoId: input.repoId,
            path: modification.path,
          }
        });
        isNew = true;
      }

      return {
        id: dbFile.id,
        isNew,
        ...modification,
      };
    })
  );

  // while we should be close to atomic, this for loop attempts
  // to use extra CL numbers in case there's a data race issue
  for (let i = 0; i < 3; i++) {
    try {
      // fetch the branch in the loop to get the latest headNumber
      const branch = await db.branch.findFirst({
        where: {
          name: input.branchName,
          repoId: input.repoId,
        },
        include: {
          repo: true,
        }
      });

      if (!branch) {
        throw new Error(`Branch ${input.branchName} not found`);
      }

      const headChangelist = await db.changelist.findFirst({
        where: {
          repoId: input.repoId,
          number: branch.headNumber,
        },
      });

      const latestChangelist = await db.changelist.findFirst({
        where: {
          repoId: input.repoId,
        },
        orderBy: {
          number: "desc",
        },
      });

      const nextChangelistNumber = latestChangelist.number + 1;

      const stateTree: Record<string, number> = Object.assign({}, latestChangelist.stateTree as any);
      for (const modification of dbModifications) {
        if (modification.id && modification.delete) {
          delete stateTree[modification.id];
        } else {
          stateTree[modification.id] = nextChangelistNumber;
        }
      }

      const changelist = await db.changelist.create({
        data: {
          number: nextChangelistNumber,
          message: input.message,
          versionIndex: input.versionIndex,
          stateTree: stateTree as any,
          repoId: input.repoId,
          userId: currentUser.id,
          parentNumber: headChangelist.number,
        },
      });

      await db.branch.update({
        where: {
          id: branch.id,
        },
        data: {
          headNumber: changelist.number,
        },
      });

      for (const modification of input.modifications) {
        let dbFile = await db.file.findFirst({
          where: {
            repoId: input.repoId,
            path: modification.oldPath || modification.path,
          },
          orderBy: {
            createdAt: "desc",
          },
        });

        let isCreate = false;
        if (!dbFile) {
          if (modification.delete) {
            throw new Error(`File not found in database when it's marked for delete: ${modification.path}`);
          } else {
            isCreate = true;
            dbFile = await db.file.create({
              data: {
                path: modification.path,
                repoId: input.repoId,
              }
            });
          }
        }

        await db.fileChange.create({
          data: {
            fileId: dbFile.id,
            repoId: input.repoId,
            changelistNumber: changelist.number,
            type:
              modification.delete ?
                FileChangeType.DELETE :
                isCreate ?
                  FileChangeType.ADD :
                  FileChangeType.MODIFY,
          },
        });
      }

      if (!input.keepCheckedOut) {
        await db.fileCheckout.updateMany({
          where: {
            workspaceId: input.workspaceId,
            fileId: {
              in: dbModifications.map((modification) => modification.id),
            }
          },
          data: {
            removedAt: new Date(),
          },
        });
      } else {
        // checkout the new files
        await db.fileCheckout.createMany({
          data: dbModifications.filter(modification => modification.isNew).map((modification) => ({
            fileId: modification.id,
            workspaceId: input.workspaceId,
            userId: currentUser.id,
            locked: false, // TODO: need to consider auto-locking rules
          })),
        });

        // remove checkout for deleted files
        await db.fileCheckout.updateMany({
          data: {
            locked: false,
            removedAt: new Date(),
          },
          where: {
            workspaceId: input.workspaceId,
            fileId: {
              in: dbModifications.filter(modification => modification.delete).map((modification) => modification.id),
            },
          },
        });
      }

      return changelist;
    } catch (e) {
      continue;
    }
  }

  throw new Error("Failed to create changelist after 3 attempts, try again");
};

export const updateChangelist: MutationResolvers["updateChangelist"] = ({
  id,
  input,
}) => {
  return db.changelist.update({
    data: input,
    where: { id },
  });
};

export const Changelist: ChangelistRelationResolvers = {
  repo: (_obj, { root }) => {
    return db.changelist.findUnique({ where: { id: root?.id } }).repo();
  },
  user: (_obj, { root }) => {
    return db.changelist.findUnique({ where: { id: root?.id } }).user();
  },
  parent: (_obj, { root }) => {
    return db.changelist.findUnique({ where: { id: root?.id } }).parent();
  },
  children: (_obj, { root }) => {
    return db.changelist.findUnique({ where: { id: root?.id } }).children();
  },
  fileChanges: (_obj, { root }) => {
    return db.changelist.findUnique({ where: { id: root?.id } }).fileChanges();
  },
};
