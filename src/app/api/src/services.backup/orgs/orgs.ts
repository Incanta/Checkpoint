import type {
  QueryResolvers,
  MutationResolvers,
  OrgRelationResolvers,
} from "types/graphql";

import { db } from "src/lib/db";
import { RepoRole } from "@prisma/client";
import { RedwoodUser } from "src/lib/auth";

export const myOrgs: QueryResolvers["myOrgs"] = (_, { context }) => {
  const currentUser: RedwoodUser = context.currentUser as RedwoodUser;

  return db.org.findMany({
    where: {
      deletedAt: null,
      users: {
        some: {
          userId: currentUser.id,
        },
      },
    },
  });
};

// where: {
//   AND: [
//     input.idIsName ? { id: input.id } : { name: input.id },
//     {
//       OR: [
//         {
//           users: {
//             some: {
//               userId: (context.currentUser as Record<string, string>).id,
//             },
//           },
//         },
//       ],
//     },
//   ],
// },

export const org: QueryResolvers["org"] = async ({ input }, { context }) => {
  const org = await db.org.findFirst({
    where: input.idIsName ? { id: input.id } : { name: input.id },
    include: {
      users: input.includeUsers || false,
      repos: input.includeRepos
        ? {
          include: {
            additionalRoles: true,
          },
        }
        : false,
    },
  });

  if (!org) {
    return null;
  }

  const currentUser: RedwoodUser = context.currentUser as RedwoodUser;

  const orgUser = await db.orgUser.findFirst({
    where: {
      orgId: org?.id,
      userId: currentUser.id,
    },
  });

  if (!orgUser) {
    return {
      id: org.id,
      name: org.name,
      repos: org.repos.filter((repo) => repo.public),
    };
  }

  return {
    id: org.id,
    deletedAt: org.deletedAt,
    deletedBy: org.deletedBy,
    name: org.name,
    defaultRepoAccess: org.defaultRepoAccess,
    defaultCanCreateRepos: org.defaultCanCreateRepos,
    users: org.users,
    repos: org.repos.filter(
      (repo) =>
        repo.public ||
        org.defaultRepoAccess !== "NONE" ||
        (repo as any).additionalRoles.some(
          (role: RepoRole) =>
            role.userId === orgUser.userId && role.access !== "NONE",
        ),
    ),
  };
};

export const createOrg: MutationResolvers["createOrg"] = async (
  { input },
  { context },
) => {
  const currentUser: RedwoodUser = context.currentUser as RedwoodUser;

  const org = await db.org.create({
    data: {
      ...input,
    },
  });

  await db.orgUser.create({
    data: {
      orgId: org.id,
      userId: currentUser.id,
      role: "ADMIN",
    },
  });

  return org;
};

export const updateOrg: MutationResolvers["updateOrg"] = async (
  { id, input },
  { context },
) => {
  const currentUser: RedwoodUser = context.currentUser as RedwoodUser;

  const orgUser = await db.orgUser.findFirst({
    where: {
      orgId: id,
      userId: currentUser.id,
    },
  });

  if (orgUser?.role === "ADMIN") {
    return db.org.update({
      data: input,
      where: { id },
    });
  } else {
    throw new Error("You do not have permission to update this organization");
  }
};

export const deleteOrg: MutationResolvers["deleteOrg"] = async (
  { id },
  { context },
) => {
  const currentUser: RedwoodUser = context.currentUser as RedwoodUser;

  const orgUser = await db.orgUser.findFirst({
    where: {
      orgId: id,
      userId: currentUser.id,
    },
  });

  if (orgUser?.role === "ADMIN") {
    return db.org.update({
      data: { deletedAt: new Date(), deletedBy: orgUser.userId },
      where: { id },
    });
  } else {
    throw new Error("You do not have permission to delete this organization");
  }
};

export const restoreOrg: MutationResolvers["restoreOrg"] = async (
  { id },
  { context },
) => {
  const currentUser: RedwoodUser = context.currentUser as RedwoodUser;

  if (currentUser.checkpointAdmin) {
    return db.org.update({
      data: { deletedAt: null, deletedBy: null },
      where: { id },
    });
  } else {
    throw new Error("You do not have permission to restore this organization");
  }
};

export const Org: OrgRelationResolvers = {
  repos: (_obj, { root }) => {
    return db.repo.findMany({ where: { orgId: root?.id } });
  },
}
