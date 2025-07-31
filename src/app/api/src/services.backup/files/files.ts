import type {
  QueryResolvers,
} from "types/graphql";

import { db } from "src/lib/db";

export const files: QueryResolvers["files"] = ({ ids }) => {
  return db.file.findMany({
    where: {
      id: {
        in: ids,
      },
    },
  });
};
