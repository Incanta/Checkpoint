import type {
  QueryResolvers,
  ModificationInput,
} from "types/graphql";

import { db } from "src/lib/db";

interface DbModification extends ModificationInput {
  id: string;
}

export const branch: QueryResolvers["branch"] = async ({ repoId, name }) => {
  const branch = await db.branch.findUnique({
    where: {
      repoId_name: {
        repoId,
        name,
      },
     },
  });

  return branch;
};

export const branches: QueryResolvers["branches"] = ({ repoId }) => {
  return db.branch.findMany({
    where: {
      repoId,
     },
  });
};
