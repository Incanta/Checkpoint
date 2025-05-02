import type {
  QueryResolvers,
  MutationResolvers,
} from "types/graphql";

import { db } from "src/lib/db";
import { RedwoodUser } from "src/lib/auth";
import { org as getOrg } from "../orgs/orgs";

export const repos: QueryResolvers["repos"] = async ({ orgId }, obj) => {
  const org = await getOrg({ input: { id: orgId, idIsName: true, includeRepos: true } }, obj);

  if (!org) {
    return [];
  }

  return org.repos as any;
};

export const repo: QueryResolvers["repo"] = async ({ id }, { context }) => {
  const repo = await db.repo.findUnique({
    where: { id },
    include: {
      org: true,
    }
  });

  if (!repo) {
    return null;
  }

  if (repo.public) {
    return repo;
  }

  const orgUser = await db.orgUser.findFirst({
    where: {
      orgId: repo.orgId,
      userId: (context.currentUser as RedwoodUser).id,
    }
  });

  if (!orgUser) {
    return null;
  }

  if (repo.org.defaultRepoAccess !== "NONE") {
    return repo;
  }

  const currentUser: RedwoodUser = context.currentUser as RedwoodUser;

  const repoRole = await db.repoRole.findFirst({
    where: {
      repoId: repo.id,
      userId: currentUser.id,
    },
  });

  if (!repoRole || repoRole.access === "NONE") {
    return null;
  }

  return repo;
};

export const createRepo: MutationResolvers["createRepo"] = async ({ input }, { context }) => {
  const currentUser: RedwoodUser = context.currentUser as RedwoodUser;

  const orgUser = await db.orgUser.findFirst({
    where: {
      orgId: input.orgId,
      userId: currentUser.id,
    },
    include: {
      org: true,
    }
  });

  if (orgUser && (orgUser.org.defaultCanCreateRepos || orgUser.role === "ADMIN")) {
    const repo = await db.repo.create({
      data: {
        public: false,
        ...input,
      }
    });

    await db.changeList.create({
      data: {
        number: 0,
        message: "Repo Creation",
        versionIndex: "",
        stateTree: {},
        repoId: repo.id,
        userId: currentUser.id,
      }
    });

    await db.branch.create({
      data: {
        name: "main",
        repoId: repo.id,
        headNumber: 0,
      }
    })

    if (orgUser.role === "MEMBER") {
      await db.repoRole.create({
        data: {
          access: "ADMIN",
          repoId: repo.id,
          userId: currentUser.id,
        }
      });
    }

    return repo;
  }

  throw new Error("User does not have permission to create a repo");
};

export const updateRepo: MutationResolvers["updateRepo"] = async ({ id, input }, { context }) => {
  const currentUser: RedwoodUser = context.currentUser as RedwoodUser;

  const repo = await db.repo.findUnique({
    where: { id },
    include: {
      org: true,
      additionalRoles: true,
    }
  });

  const orgUser = await db.orgUser.findFirst({
    where: {
      orgId: repo.orgId,
      userId: currentUser.id,
    },
    include: {
      org: true,
    }
  });

  if (
    orgUser &&
    (
      orgUser.role === "ADMIN" ||
      repo.additionalRoles.some(role => role.userId === currentUser.id && role.access === "ADMIN")
    )
  ) {
    return db.repo.update({
      where: { id },
      data: input,
    });
  }

  throw new Error("User does not have permission to update the repo");
};

export const deleteRepo: MutationResolvers["deleteRepo"] = async ({ id }, { context }) => {
  const currentUser: RedwoodUser = context.currentUser as RedwoodUser;

  const repo = await db.repo.findUnique({
    where: { id },
    include: {
      org: true,
      additionalRoles: true,
    }
  });

  const orgUser = await db.orgUser.findFirst({
    where: {
      orgId: repo.orgId,
      userId: currentUser.id,
    },
    include: {
      org: true,
    }
  });

  if (
    orgUser &&
    (
      orgUser.role === "ADMIN" ||
      repo.additionalRoles.some(role => role.userId === currentUser.id && role.access === "ADMIN")
    )
  ) {
    return db.repo.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        deletedBy: currentUser.id,
      },
    });
  }

  throw new Error("User does not have permission to delete the repo");
};

export const restoreRepo: MutationResolvers["restoreRepo"] = async (
  { id },
  { context },
) => {
  const currentUser: RedwoodUser = context.currentUser as RedwoodUser;

  if (currentUser.checkpointAdmin) {
    return db.repo.update({
      data: { deletedAt: null, deletedBy: null },
      where: { id },
    });
  } else {
    throw new Error("You do not have permission to restore this repo");
  }
};
