import { Prisma, type PrismaClient } from "@prisma/client";

export interface ChangelistWalkResult {
  /** Ancestor changelist numbers starting at (and including) startNumber. */
  numbers: number[];
  /**
   * The parent of the last returned changelist: pass as startNumber to
   * continue the walk, or null when the root was reached.
   */
  nextNumber: number | null;
}

/**
 * Walks a changelist's ancestor chain (via parentNumber) in a single query
 * using a recursive CTE. The identical SQL runs on both sqlite and postgres.
 *
 * Returns at most `limit` changelists, ordered newest-first (walk order).
 */
export async function walkChangelistAncestry(
  db: PrismaClient | Prisma.TransactionClient,
  repoId: string,
  startNumber: number,
  limit: number,
): Promise<ChangelistWalkResult> {
  if (limit <= 0) {
    return { numbers: [], nextNumber: startNumber };
  }

  const rows = await db.$queryRaw<
    { number: number | bigint; parentNumber: number | bigint | null }[]
  >(Prisma.sql`
    WITH RECURSIVE ancestry AS (
      SELECT "number", "parentNumber", 0 AS depth
      FROM "Changelist"
      WHERE "repoId" = ${repoId} AND "number" = ${startNumber}
      UNION ALL
      SELECT c."number", c."parentNumber", a.depth + 1
      FROM "Changelist" c
      JOIN ancestry a
        ON c."repoId" = ${repoId} AND c."number" = a."parentNumber"
      WHERE a.depth < ${limit - 1}
    )
    SELECT "number", "parentNumber" FROM ancestry ORDER BY depth
  `);

  const numbers = rows.map((row) => Number(row.number));
  const nextParent = rows.at(-1)?.parentNumber;
  const nextNumber = nextParent == null ? null : Number(nextParent);

  return { numbers, nextNumber };
}
