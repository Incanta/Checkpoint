import type {
  QueryResolvers,
  MutationResolvers,
  UserRelationResolvers,
} from "types/graphql";

import { db } from "src/lib/db";
import { RedwoodUser } from "src/lib/auth";

export const me: QueryResolvers["me"] = ({}, { context }) => {
  const currentUser: RedwoodUser = context.currentUser as RedwoodUser;
  return db.user.findUnique({
    where: { id: currentUser.id },
  });
};

export const users: QueryResolvers["users"] = () => {
  return db.user.findMany();
};

export const user: QueryResolvers["user"] = ({ id }) => {
  return db.user.findUnique({
    where: { id },
  });
};

export const createUser: MutationResolvers["createUser"] = ({ input }) => {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("createUser is only available in testing environments");
  }

  return db.user.create({
    data: input,
  });
};

export const updateUser: MutationResolvers["updateUser"] = ({ id, input }) => {
  return db.user.update({
    data: input,
    where: { id },
  });
};

export const User: UserRelationResolvers = {
  orgs: (_obj, { root }) => {
    return db.user.findUnique({ where: { id: root?.id } }).orgs();
  },
  specificRepoRoles: (_obj, { root }) => {
    return db.user.findUnique({ where: { id: root?.id } }).specificRepoRoles();
  },
  fileCheckouts: (_obj, { root }) => {
    return db.user.findUnique({ where: { id: root?.id } }).fileCheckouts();
  },
  changelists: (_obj, { root }) => {
    return db.user.findUnique({ where: { id: root?.id } }).changelists();
  },
};
