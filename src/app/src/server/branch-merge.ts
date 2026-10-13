// Merging one branch into another.
//
// A changelist's state tree maps every path to the changelist that last wrote
// it. A merge is therefore a question about three trees: the merge base (the
// last changelist both branches share), the target head, and the incoming
// head. A path "changed" on a side when that side's tree names a different
// changelist for it than the base does.
//
// The merge used to copy every entry of the incoming tree over the target
// tree. That is not a merge: any file changed on the target after the branch
// was cut, and never touched by the branch at all, went back to the branch's
// older copy. It also collected the branch's changelists by walking parents
// until a number at or below the target head, which stops at the first
// changelist whenever the target has moved on since the branch was cut.
//
// What happens now, for each path:
//
//   - only the incoming side changed it: take the incoming version;
//   - only the target side changed it: keep the target version;
//   - both changed it to the same thing: nothing to do;
//   - both changed it differently: a conflict, and the merge is refused.
//
// A conflict is never resolved by picking a side here. Resolving it takes the
// content, which only a workspace has: pull the target into the branch,
// resolve there, submit, and merge again.

import { FileChangeType, type Prisma, type PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import type { InputJsonValue } from "@prisma/client/runtime/library";

import {
  MAX_SUBMIT_ATTEMPTS,
  SubmitContention,
  isSubmitContention,
} from "~/server/changelist-commit";
import { walkChangelistAncestry } from "~/server/changelist-walk";
import { releaseClaimsForBranch } from "~/server/claims/claims";
import { restackChildren } from "~/server/claims/domain";
import { settleClaimsForMerge } from "~/server/claims/landing";
import {
  buildStateTreeBlocks,
  getStateTreePaths,
  primeStateTreePaths,
} from "~/server/state-tree";

type Tree = ReadonlyMap<string, number>;

export interface MergeConflict {
  path: string;
  /** Changelist holding the path at the merge base; null if it was absent. */
  base: number | null;
  /** The same at the target head. */
  target: number | null;
  /** The same at the incoming head. */
  incoming: number | null;
}

export interface AppliedChange {
  path: string;
  /** The incoming changelist to take, or null to delete the path. */
  incoming: number | null;
}

export interface TreeMerge {
  /** The target tree with the incoming side's changes applied. */
  merged: Map<string, number>;
  /** What the merge changed in the target, in path order. */
  applied: AppliedChange[];
  /** Paths both sides changed differently. Non-empty means do not merge. */
  conflicts: MergeConflict[];
}

/** Three-way merge of state trees. Pure; see the top of this file. */
export function mergeTrees(
  base: Tree,
  target: Tree,
  incoming: Tree,
): TreeMerge {
  const merged = new Map(target);
  const applied: AppliedChange[] = [];
  const conflicts: MergeConflict[] = [];

  // A path the incoming side changed is in its tree (added or modified) or in
  // the base tree (deleted), so these two cover every candidate.
  const candidates = new Set<string>([...incoming.keys(), ...base.keys()]);

  for (const path of [...candidates].sort()) {
    const b = base.get(path) ?? null;
    const i = incoming.get(path) ?? null;
    if (i === b) {
      continue; // The incoming side did not change it; the target stands.
    }

    const t = target.get(path) ?? null;
    if (t === i) {
      continue; // Both sides ended up in the same place.
    }

    if (t !== b) {
      conflicts.push({ path, base: b, target: t, incoming: i });
      continue;
    }

    if (i === null) {
      merged.delete(path);
    } else {
      merged.set(path, i);
    }
    applied.push({ path, incoming: i });
  }

  return { merged, applied, conflicts };
}

const MAX_LISTED_CONFLICTS = 50;

export function describeMergeConflicts(
  incomingBranchName: string,
  targetBranchName: string,
  conflicts: readonly MergeConflict[],
): string {
  const side = (n: number | null, base: number | null) =>
    n === null
      ? "deleted"
      : base === null
        ? `added in #${n}`
        : `changed in #${n}`;
  const lines = conflicts
    .slice(0, MAX_LISTED_CONFLICTS)
    .map(
      (c) =>
        `${c.path} (${incomingBranchName}: ${side(c.incoming, c.base)}; ${targetBranchName}: ${side(c.target, c.base)})`,
    );
  if (conflicts.length > MAX_LISTED_CONFLICTS) {
    lines.push(`and ${conflicts.length - MAX_LISTED_CONFLICTS} more`);
  }
  const noun = conflicts.length === 1 ? "file was" : "files were";
  return (
    `Cannot merge ${incomingBranchName} into ${targetBranchName}: ${conflicts.length} ${noun} changed on both branches. ` +
    `Nothing was merged. Bring ${targetBranchName} into ${incomingBranchName}, resolve them there, and merge again:\n` +
    lines.join("\n")
  );
}

type Db = PrismaClient | Prisma.TransactionClient;

/** A branch's changelists from `start` back to the root, newest first. */
async function* ancestry(
  db: Db,
  repoId: string,
  start: number,
): AsyncGenerator<number> {
  let next: number | null = start;
  while (next !== null) {
    const page = await walkChangelistAncestry(db, repoId, next, 512);
    if (page.numbers.length === 0) {
      return;
    }
    yield* page.numbers;
    next = page.nextNumber;
  }
}

export interface MergeBase {
  /** The newest changelist both heads descend from. */
  base: number;
  /** The incoming side's own changelists, newest first. */
  incomingNumbers: number[];
}

/**
 * Finds the merge base of two heads.
 *
 * A changelist's number is always greater than its parent's, so each line of
 * history is a strictly descending sequence. Walking both down, always
 * stepping whichever is currently higher, the first number they agree on is
 * the newest one they share.
 */
export async function findMergeBase(
  db: Db,
  repoId: string,
  targetHead: number,
  incomingHead: number,
): Promise<MergeBase | null> {
  const targetLine = ancestry(db, repoId, targetHead);
  const incomingLine = ancestry(db, repoId, incomingHead);
  const incomingNumbers: number[] = [];

  let t = await targetLine.next();
  let i = await incomingLine.next();
  while (!t.done && !i.done) {
    if (t.value === i.value) {
      return { base: t.value, incomingNumbers };
    }
    if (t.value > i.value) {
      t = await targetLine.next();
    } else {
      incomingNumbers.push(i.value);
      i = await incomingLine.next();
    }
  }
  return null;
}

export interface MergeBranchParams {
  repoId: string;
  incomingBranchName: string;
  targetBranchName: string;
  userId: string;
  /**
   * Refuse unless the incoming branch is a feature branch whose parent is the
   * target. The direct merge enforces this; a merge request has already been
   * validated against its own rules.
   */
  requireParentRelation: boolean;
  /**
   * Extra writes that belong to the same commit (a merge request marks itself
   * merged here), so they cannot be left behind by a merge that did not land.
   */
  alsoInTransaction?: (
    tx: Prisma.TransactionClient,
    mergeChangelistNumber: number,
  ) => Promise<void>;
}

export interface MergeBranchResult {
  id: string;
  number: number;
  message: string;
  deletedBranch: string;
}

/**
 * Squash-merges a branch into its target and deletes it. All or nothing: the
 * merge changelist, the head move, the file changes, the claim settlement,
 * the restack, and the branch deletion commit together or not at all.
 */
export async function mergeBranch(
  db: PrismaClient,
  params: MergeBranchParams,
): Promise<MergeBranchResult> {
  const { repoId, incomingBranchName, targetBranchName, userId } = params;

  for (let attempt = 0; attempt < MAX_SUBMIT_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, 15 * attempt + Math.random() * 60),
      );
    }

    const incomingBranch = await db.branch.findUnique({
      where: { repoId_name: { repoId, name: incomingBranchName } },
    });
    if (!incomingBranch) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Incoming branch "${incomingBranchName}" not found`,
      });
    }

    const targetBranch = await db.branch.findUnique({
      where: { repoId_name: { repoId, name: targetBranchName } },
    });
    if (!targetBranch) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Target branch "${targetBranchName}" not found`,
      });
    }

    if (incomingBranch.id === targetBranch.id) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "A branch cannot be merged into itself",
      });
    }

    if (params.requireParentRelation) {
      // Validate: only feature branches can be merged, into their parent
      if (incomingBranch.type !== "FEATURE") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only feature branches can be merged",
        });
      }
      if (incomingBranch.parentBranchName !== targetBranch.name) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A feature branch can only be merged into its parent branch",
        });
      }
    }

    if (targetBranch.archivedAt) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Cannot merge into an archived branch",
      });
    }
    if (incomingBranch.archivedAt) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Cannot merge an archived branch",
      });
    }

    const mergeBase = await findMergeBase(
      db,
      repoId,
      targetBranch.headNumber,
      incomingBranch.headNumber,
    );
    if (!mergeBase) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `${incomingBranchName} and ${targetBranchName} share no history`,
      });
    }
    if (mergeBase.incomingNumbers.length === 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "No changelists to merge",
      });
    }

    const incomingCls = await db.changelist.findMany({
      where: { repoId, number: { in: mergeBase.incomingNumbers } },
      orderBy: { number: "desc" },
    });
    const incomingHead = incomingCls.find(
      (cl) => cl.number === incomingBranch.headNumber,
    );
    const targetHead = await db.changelist.findUnique({
      where: {
        repoId_number: { repoId, number: targetBranch.headNumber },
      },
    });
    if (!incomingHead || !targetHead) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Could not find branch head changelists",
      });
    }

    const [basePaths, targetPaths, incomingPaths] = await Promise.all([
      getStateTreePaths(db, repoId, mergeBase.base),
      getStateTreePaths(db, repoId, targetHead.number),
      getStateTreePaths(db, repoId, incomingHead.number),
    ]);

    const { merged, applied, conflicts } = mergeTrees(
      basePaths,
      targetPaths,
      incomingPaths,
    );
    if (conflicts.length > 0) {
      throw new TRPCError({
        code: "CONFLICT",
        message: describeMergeConflicts(
          incomingBranchName,
          targetBranchName,
          conflicts,
        ),
      });
    }

    // Build the squash merge message
    const firstLine = `Merged ${incomingBranchName} into ${targetBranchName}`;
    const clMessages = incomingCls
      .map((cl) => `#${cl.number} ${cl.message}`)
      .join("\n");
    const mergeMessage = `${firstLine}\n\n${clMessages}`;

    // Merge artifact state trees: incoming overwrites target. Artifacts are
    // build outputs keyed to the source they were built from, so the branch's
    // builds are the ones that match what was just merged.
    const targetArtifactState: Record<string, number> = {
      ...((targetHead.artifactStateTree as Record<string, number>) ?? {}),
    };
    const incomingArtifactState: Record<string, number> =
      (incomingHead.artifactStateTree as Record<string, number>) ?? {};
    for (const [fileId, clNum] of Object.entries(incomingArtifactState)) {
      targetArtifactState[fileId] = clNum;
    }

    // The branch's own file changes say which File row each path uses and
    // carry rename information. Newest wins.
    const incomingFileChanges = await db.fileChange.findMany({
      where: { repoId, changelistNumber: { in: mergeBase.incomingNumbers } },
      include: { file: { select: { path: true } } },
      orderBy: { changelistNumber: "asc" },
    });
    const latestByPath = new Map<
      string,
      { fileId: string; oldPath: string | null }
    >();
    for (const fc of incomingFileChanges) {
      latestByPath.set(fc.file.path, {
        fileId: fc.fileId,
        oldPath: fc.oldPath,
      });
    }

    const lastCl = await db.changelist.findFirst({
      where: { repoId },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const nextNumber = (lastCl?.number ?? -1) + 1;

    const stateRootHash = await buildStateTreeBlocks(
      db,
      repoId,
      merged.entries(),
    );

    try {
      const mergeCl = await db.$transaction(
        async (tx) => {
          // The merge changelist uploads nothing of its own: every path in
          // its tree still points at the changelist that did. So it has no
          // version index. It used to borrow the incoming head's, which holds
          // only that one changelist's files.
          const created = await tx.changelist.create({
            data: {
              number: nextNumber,
              message: mergeMessage,
              versionIndex: "",
              parentNumber: targetBranch.headNumber,
              stateRootHash,
              artifactVersionIndex: incomingHead.artifactVersionIndex,
              artifactStateTree:
                Object.keys(targetArtifactState).length > 0
                  ? (targetArtifactState as InputJsonValue)
                  : undefined,
              repoId,
              userId,
            },
          });

          // Both heads must be where this attempt found them: the target's,
          // or the merge would drop whatever landed on it meanwhile, and the
          // incoming one's, or a submit to the branch during the merge would
          // be deleted along with the branch without ever being merged.
          const moved = await tx.branch.updateMany({
            where: {
              id: targetBranch.id,
              headNumber: targetBranch.headNumber,
              archivedAt: null,
            },
            data: { headNumber: nextNumber },
          });
          // Written, not just read, so the row is held until this commits and
          // a submit to the branch cannot slip in between the check and the
          // delete below.
          const stillThere = await tx.branch.updateMany({
            where: {
              id: incomingBranch.id,
              headNumber: incomingBranch.headNumber,
              archivedAt: null,
            },
            data: { headNumber: incomingBranch.headNumber },
          });
          if (moved.count !== 1 || stillThere.count !== 1) {
            throw new SubmitContention("a branch head moved during the merge");
          }

          const rows = applied.flatMap((change) => {
            const source = latestByPath.get(change.path);
            return source
              ? [
                  {
                    repoId,
                    fileId: source.fileId,
                    changelistNumber: nextNumber,
                    type:
                      change.incoming === null
                        ? FileChangeType.DELETE
                        : FileChangeType.MODIFY,
                    oldPath: source.oldPath,
                  },
                ]
              : [];
          });
          const BATCH_SIZE = 20000;
          for (let i = 0; i < rows.length; i += BATCH_SIZE) {
            await tx.fileChange.createMany({
              data: rows.slice(i, i + BATCH_SIZE),
            });
          }

          // Settle claims the merge carried. Release when the target anchors
          // its own domain (the work has landed), advance onto the target
          // otherwise (a stacked branch merged one rung up, still in flight).
          await settleClaimsForMerge(tx, {
            repoId,
            incomingBranchName,
            targetBranchName,
            mergeChangelistNumber: nextNumber,
            paths: [...latestByPath.keys()],
            actor: { userId },
          });

          // Restack: anything stacked on the merged branch re-parents to its
          // parent. Without this a stack deadlocks, because a branch can only
          // merge into its own parent and merging into an archived or deleted
          // branch is refused. Domains are unaffected, since a branch and its
          // parent always share one.
          await restackChildren(tx, {
            repoId,
            mergedBranchName: incomingBranchName,
            newParentBranchName: targetBranchName,
          });

          // Release anything still held on the merged branch that the merge
          // did not carry (claims taken but never submitted).
          await releaseClaimsForBranch(tx, repoId, incomingBranchName, {
            userId,
          });

          await params.alsoInTransaction?.(tx, nextNumber);

          // Delete the incoming branch (CLs are preserved)
          await tx.branch.delete({ where: { id: incomingBranch.id } });

          return created;
        },
        { maxWait: 60_000, timeout: 15 * 60_000 },
      );

      primeStateTreePaths(repoId, stateRootHash, merged);

      return {
        id: mergeCl.id,
        number: mergeCl.number,
        message: mergeCl.message,
        deletedBranch: incomingBranchName,
      };
    } catch (error) {
      if (!isSubmitContention(error)) {
        throw error;
      }
    }
  }

  throw new TRPCError({
    code: "CONFLICT",
    message: `Could not merge ${incomingBranchName} into ${targetBranchName}: the branches kept changing. Nothing was merged; try again.`,
  });
}
