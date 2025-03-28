import type {
  QueryResolvers,
  MutationResolvers,
  ChangeListRelationResolvers,
} from "types/graphql";

import { db } from "src/lib/db";

export const changeLists: QueryResolvers["changeLists"] = () => {
  return db.changeList.findMany();
};

export const changeList: QueryResolvers["changeList"] = ({ id }) => {
  return db.changeList.findUnique({
    where: { id },
  });
};

export const createChangeList: MutationResolvers["createChangeList"] = ({
  input,
}) => {
  return db.changeList.create({
    data: input,
  });
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

export const deleteChangeList: MutationResolvers["deleteChangeList"] = ({
  id,
}) => {
  return db.changeList.delete({
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
  heads: (_obj, { root }) => {
    return db.changeList.findUnique({ where: { id: root?.id } }).heads();
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
