import type {
  QueryResolvers,
  MutationResolvers,
  ChangeListRelationResolvers,
  ModificationInput,
} from "types/graphql";

import { db } from "src/lib/db";
import { RedwoodUser } from "src/lib/auth";
import { FileChangeType } from "@prisma/client";

interface DbModification extends ModificationInput {
  id: string;
}

export const changeList: QueryResolvers["changeList"] = ({ id }) => {
  return db.changeList.findUnique({
    where: { id },
  });
};

export const changeLists: QueryResolvers["changeLists"] = ({ repoId, numbers }) => {
  return db.changeList.findMany({
    where: {
      repoId,
      number: {
        in: numbers,
      },
     },
  });
};

export const createChangeList: MutationResolvers["createChangeList"] = async ({
  input,
}) => {
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

      if (!dbFile) {
        dbFile = await db.file.create({
          data: {
            repoId: input.repoId,
            path: modification.path,
          }
        });
      }

      return {
        id: dbFile.id,
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

      const headChangeList = await db.changeList.findFirst({
        where: {
          repoId: input.repoId,
          number: branch.headNumber,
        },
      });

      const latestChangeList = await db.changeList.findFirst({
        where: {
          repoId: input.repoId,
        },
        orderBy: {
          number: "desc",
        },
      });

      const nextChangeListNumber = latestChangeList.number + 1;

      const stateTree: Record<string, number> = Object.assign({}, latestChangeList.stateTree as any);
      for (const modification of dbModifications) {
        if (modification.id && modification.delete) {
          delete stateTree[modification.id];
        } else {
          stateTree[modification.id] = nextChangeListNumber;
        }
      }

      const changelist = await db.changeList.create({
        data: {
          number: nextChangeListNumber,
          message: input.message,
          versionIndex: input.versionIndex,
          stateTree: stateTree as any,
          repoId: input.repoId,
          userId: currentUser.id,
          parentNumber: headChangeList.number,
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
            changeListNumber: changelist.number,
            type:
              modification.delete ?
                FileChangeType.DELETE :
                isCreate ?
                  FileChangeType.ADD :
                  FileChangeType.MODIFY,
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

export const updateChangeList: MutationResolvers["updateChangeList"] = ({
  id,
  input,
}) => {
  return db.changeList.update({
    data: input,
    where: { id },
  });
};

export const ChangeList: ChangeListRelationResolvers = {
  repo: (_obj, { root }) => {
    return db.changeList.findUnique({ where: { id: root?.id } }).repo();
  },
  user: (_obj, { root }) => {
    return db.changeList.findUnique({ where: { id: root?.id } }).user();
  },
  parent: (_obj, { root }) => {
    return db.changeList.findUnique({ where: { id: root?.id } }).parent();
  },
  children: (_obj, { root }) => {
    return db.changeList.findUnique({ where: { id: root?.id } }).children();
  },
  fileChanges: (_obj, { root }) => {
    return db.changeList.findUnique({ where: { id: root?.id } }).fileChanges();
  },
};
