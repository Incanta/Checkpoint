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
  diffStateTreeRoots,
  getStateTreePaths,
  lookupStateTreePaths,
  stateRootOf,
  submitStateTree,
} from "~/server/state-tree";
import { TreeCollisionError, type TreeEdit } from "~/server/tree/tree";

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

/**
 * The same three-way merge as {@link mergeTrees}, computed from the trees
 * without materializing them. Only paths the incoming side changed can be
 * merged or conflict, and a hash-skipping diff of base against incoming finds
 * exactly those; base and target are then read at just those paths.
 */
export async function mergeStateTreesSparse(
  db: PrismaClient,
  repoId: string,
  baseRoot: string,
  targetRoot: string,
  incomingRoot: string,
): Promise<{
  applied: AppliedChange[];
  conflicts: MergeConflict[];
  targetAt: Map<string, number>;
}> {
  const d = await diffStateTreeRoots(db, repoId, baseRoot, incomingRoot);
  const incomingAt = new Map<string, number | null>();
  for (const c of d.added) incomingAt.set(c.path, c.cl);
  for (const c of d.modified) incomingAt.set(c.path, c.cl);
  for (const p of d.removed) incomingAt.set(p, null);

  const candidates = [...incomingAt.keys()].sort();
  const [baseAt, targetAt] = await Promise.all([
    lookupStateTreePaths(db, repoId, baseRoot, candidates),
    lookupStateTreePaths(db, repoId, targetRoot, candidates),
  ]);

  const applied: AppliedChange[] = [];
  const conflicts: MergeConflict[] = [];
  for (const path of candidates) {
    const b = baseAt.get(path) ?? null;
    const i = incomingAt.get(path) ?? null;
    if (i === b) continue;
    const t = targetAt.get(path) ?? null;
    if (t === i) continue;
    if (t !== b) {
      conflicts.push({ path, base: b, target: t, incoming: i });
      continue;
    }
    applied.push({ path, incoming: i });
  }
  return { applied, conflicts, targetAt };
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
    `Nothing was merged. Update ${incomingBranchName} from ${targetBranchName} (resolving these on ${incomingBranchName}), and merge again:\n` +
    lines.join("\n")
  );
}

type Db = PrismaClient | Prisma.TransactionClient;

/** A changelist's parents: its own parent, and for a merge, the head it merged. */
interface Links {
  parent: number | null;
  mergedFrom: number | null;
}

/**
 * Loads the parent links of `number` and of the ancestors a page of the
 * linear walk reaches from it (one query for the walk, one for the merge
 * links), so long histories cost a query per page, not per changelist.
 */
async function loadLinks(
  db: Db,
  repoId: string,
  number: number,
  links: Map<number, Links>,
): Promise<void> {
  const page = await walkChangelistAncestry(db, repoId, number, 512);
  if (page.numbers.length === 0) {
    links.set(number, { parent: null, mergedFrom: null });
    return;
  }
  const rows = await db.changelist.findMany({
    where: { repoId, number: { in: page.numbers } },
    select: { number: true, mergedFromNumber: true },
  });
  const mergedFrom = new Map(rows.map((r) => [r.number, r.mergedFromNumber]));
  page.numbers.forEach((n, i) => {
    if (links.has(n)) return;
    links.set(n, {
      parent:
        i + 1 < page.numbers.length ? page.numbers[i + 1]! : page.nextNumber,
      mergedFrom: mergedFrom.get(n) ?? null,
    });
  });
}

/** A max-heap of changelist numbers. */
class NumberHeap {
  private readonly items: number[] = [];
  get size(): number {
    return this.items.length;
  }
  push(n: number): void {
    const a = this.items;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (a[up]! >= a[i]!) break;
      [a[up], a[i]] = [a[i]!, a[up]!];
      i = up;
    }
  }
  pop(): number {
    const a = this.items;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let big = i;
        if (l < a.length && a[l]! > a[big]!) big = l;
        if (r < a.length && a[r]! > a[big]!) big = r;
        if (big === i) break;
        [a[big], a[i]] = [a[i]!, a[big]!];
        i = big;
      }
    }
    return top;
  }
}

export interface MergeBase {
  /** The newest changelist both heads descend from. */
  base: number;
  /** The incoming side's own changelists, newest first. */
  incomingNumbers: number[];
}

/**
 * Finds the merge base of two heads: the newest changelist both descend from.
 *
 * History is a graph, not a line: a merge changelist has its target as its
 * parent and the head it merged as a second parent (mergedFromNumber). Work a
 * merge already carried is then shared history, so it is never compared
 * again, which is what lets a stacked branch merge after its parent merged
 * (DL-13) and a branch merge once its parent was brought into it (DL-14).
 *
 * Both parent edges only ever lead to lower numbers, so walking both heads
 * best-first by number visits every changelist after all its descendants,
 * when it is known which heads reach it. The first one both reach is the
 * newest common ancestor. The changelists only the incoming head reaches,
 * before it, are the incoming side's own.
 */
export async function findMergeBase(
  db: Db,
  repoId: string,
  targetHead: number,
  incomingHead: number,
): Promise<MergeBase | null> {
  const TARGET = 1;
  const INCOMING = 2;
  const links = new Map<number, Links>();
  const reach = new Map<number, number>();
  const heap = new NumberHeap();
  const mark = (n: number | null, side: number) => {
    if (n === null) return;
    const had = reach.get(n) ?? 0;
    if ((had | side) === had) return;
    reach.set(n, had | side);
    if (had === 0) heap.push(n);
  };
  mark(targetHead, TARGET);
  mark(incomingHead, INCOMING);

  const incomingNumbers: number[] = [];
  while (heap.size > 0) {
    const n = heap.pop();
    const side = reach.get(n)!;
    if (side === (TARGET | INCOMING)) {
      return { base: n, incomingNumbers };
    }
    if (side === INCOMING) incomingNumbers.push(n);
    if (!links.has(n)) await loadLinks(db, repoId, n, links);
    const { parent, mergedFrom } = links.get(n)!;
    mark(parent, side);
    mark(mergedFrom, side);
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

    const baseRoot = await stateRootOf(db, repoId, mergeBase.base);
    const targetRoot = targetHead.stateRootHash ?? null;
    const incomingRoot = incomingHead.stateRootHash ?? null;

    // With all three trees present, merge from the trees directly: only the
    // paths the incoming side changed are read. Changelists without a tree
    // (test fixtures) fall back to comparing the full maps.
    let applied: AppliedChange[];
    let conflicts: MergeConflict[];
    let targetAt: ReadonlyMap<string, number>;
    if (baseRoot && targetRoot && incomingRoot) {
      ({ applied, conflicts, targetAt } = await mergeStateTreesSparse(
        db,
        repoId,
        baseRoot,
        targetRoot,
        incomingRoot,
      ));
    } else {
      const [basePaths, targetPaths, incomingPaths] = await Promise.all([
        getStateTreePaths(db, repoId, mergeBase.base),
        getStateTreePaths(db, repoId, targetHead.number),
        getStateTreePaths(db, repoId, incomingHead.number),
      ]);
      ({ applied, conflicts } = mergeTrees(
        basePaths,
        targetPaths,
        incomingPaths,
      ));
      targetAt = targetPaths;
    }
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

    // Writes outside the transaction, so with a single-writer database it can
    // lose the wait to another commit. Same contention, same answer.
    // The merged tree is the target's with the applied changes. When the
    // target has not moved since the base, that is exactly the incoming tree
    // (trees are canonical), so nothing needs building.
    const edits: TreeEdit[] = applied.map((change) =>
      change.incoming === null
        ? { path: change.path, delete: true as const }
        : { path: change.path, cl: change.incoming },
    );
    let fileCount = targetHead.fileCount;
    if (fileCount !== null) {
      for (const change of applied) {
        const atTarget = targetAt.has(change.path);
        if (change.incoming !== null && !atTarget) fileCount++;
        if (change.incoming === null && atTarget) fileCount--;
      }
    }

    let stateRootHash: string;
    try {
      stateRootHash =
        targetRoot && incomingRoot && targetRoot === baseRoot
          ? incomingRoot
          : await submitStateTree(
              db,
              repoId,
              targetHead.number,
              targetRoot,
              edits,
              {
                foldNames:
                  (
                    await db.repo.findUnique({
                      where: { id: repoId },
                      select: { pathPortability: true },
                    })
                  )?.pathPortability ?? true,
              },
            );
    } catch (error) {
      if (error instanceof TreeCollisionError) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Cannot merge ${incomingBranchName} into ${targetBranchName}: ${error.message}. Nothing was merged.`,
        });
      }
      if (!isSubmitContention(error)) {
        throw error;
      }
      continue;
    }

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
              // The incoming head, as a second parent: what this merge
              // carried is shared history from now on (findMergeBase).
              mergedFromNumber: incomingBranch.headNumber,
              stateRootHash,
              fileCount,
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
                    sourceChangelistNumber: change.incoming,
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

          // Delete the incoming branch (CLs are preserved), keeping its head
          // so it can be restored.
          await tx.deletedBranch.create({
            data: {
              repoId,
              name: incomingBranch.name,
              headNumber: incomingBranch.headNumber,
              type: incomingBranch.type,
              parentBranchName: incomingBranch.parentBranchName,
              domainBranchName: incomingBranch.domainBranchName,
              merged: true,
              deletedById: userId,
            },
          });
          await tx.branch.delete({ where: { id: incomingBranch.id } });

          return created;
        },
        { maxWait: 60_000, timeout: 15 * 60_000 },
      );

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

export interface UpdateFromParentParams {
  repoId: string;
  branchName: string;
  userId: string;
  /**
   * The parent head the caller resolved conflicts against. Refused if the
   * parent has moved since, so a resolution never covers changes it did not
   * see.
   */
  parentHeadNumber?: number;
  /**
   * A changelist on the branch that resolves the conflicts: each path both
   * sides changed that it touched keeps the branch's version. Paths it did
   * not touch still conflict.
   */
  resolvedInNumber?: number;
}

export type UpdateFromParentResult =
  | { status: "up-to-date"; headNumber: number }
  | { status: "updated"; number: number; applied: number };

/**
 * Brings a feature branch's parent into it: a changelist on the branch that
 * applies everything the parent changed since they last shared history, with
 * the parent's head as its second parent (mergedFromNumber), so the merge base
 * moves and the branch can merge cleanly later (DL-14).
 *
 * A path both sides changed is a conflict. The way through is to resolve it
 * on the branch (submit the resolved file there) and update again naming that
 * changelist as \`resolvedInNumber\`: the branch keeps its version of each path
 * the resolution touched.
 */
export async function updateBranchFromParent(
  db: PrismaClient,
  params: UpdateFromParentParams,
): Promise<UpdateFromParentResult> {
  const { repoId, branchName, userId } = params;

  for (let attempt = 0; attempt < MAX_SUBMIT_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, 15 * attempt + Math.random() * 60),
      );
    }

    const branch = await db.branch.findUnique({
      where: { repoId_name: { repoId, name: branchName } },
    });
    if (!branch) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Branch "${branchName}" not found`,
      });
    }
    if (branch.type !== "FEATURE" || !branch.parentBranchName) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Only a feature branch can be updated from its parent",
      });
    }
    if (branch.archivedAt) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Cannot update an archived branch",
      });
    }
    const parentName = branch.parentBranchName;
    const parent = await db.branch.findUnique({
      where: { repoId_name: { repoId, name: parentName } },
    });
    if (!parent) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Parent branch "${parentName}" not found`,
      });
    }
    if (
      params.parentHeadNumber !== undefined &&
      parent.headNumber !== params.parentHeadNumber
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `${parentName} has moved since #${params.parentHeadNumber}: update again against #${parent.headNumber}`,
      });
    }

    // Here the branch is the target and its parent comes in.
    const mergeBase = await findMergeBase(
      db,
      repoId,
      branch.headNumber,
      parent.headNumber,
    );
    if (!mergeBase) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `${branchName} and ${parentName} share no history`,
      });
    }
    if (mergeBase.incomingNumbers.length === 0) {
      return { status: "up-to-date", headNumber: branch.headNumber };
    }

    const [branchHead, parentHead] = await Promise.all([
      db.changelist.findUnique({
        where: { repoId_number: { repoId, number: branch.headNumber } },
      }),
      db.changelist.findUnique({
        where: { repoId_number: { repoId, number: parent.headNumber } },
      }),
    ]);
    if (!branchHead || !parentHead) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Could not find branch head changelists",
      });
    }
    const baseRoot = await stateRootOf(db, repoId, mergeBase.base);
    const branchRoot = branchHead.stateRootHash ?? null;
    const parentRoot = parentHead.stateRootHash ?? null;

    let applied: AppliedChange[];
    let conflicts: MergeConflict[];
    let targetAt: ReadonlyMap<string, number>;
    if (baseRoot && branchRoot && parentRoot) {
      ({ applied, conflicts, targetAt } = await mergeStateTreesSparse(
        db,
        repoId,
        baseRoot,
        branchRoot,
        parentRoot,
      ));
    } else {
      const [basePaths, branchPaths, parentPaths] = await Promise.all([
        getStateTreePaths(db, repoId, mergeBase.base),
        getStateTreePaths(db, repoId, branchHead.number),
        getStateTreePaths(db, repoId, parentHead.number),
      ]);
      ({ applied, conflicts } = mergeTrees(
        basePaths,
        branchPaths,
        parentPaths,
      ));
      targetAt = branchPaths;
    }

    if (conflicts.length > 0 && params.resolvedInNumber !== undefined) {
      const resolution = await db.changelist.findUnique({
        where: {
          repoId_number: { repoId, number: params.resolvedInNumber },
        },
      });
      // The resolution must be on the branch, after it last shared history
      // with the parent: walking the branch down to the base must reach it.
      const onBranch =
        resolution !== null &&
        resolution.number > mergeBase.base &&
        (await findMergeBase(db, repoId, branch.headNumber, resolution.number))
          ?.base === resolution.number;
      if (!onBranch) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `#${params.resolvedInNumber} is not a changelist on ${branchName} since it last shared history with ${parentName}`,
        });
      }
      const touched = new Set(
        (
          await db.fileChange.findMany({
            where: { repoId, changelistNumber: params.resolvedInNumber },
            include: { file: { select: { path: true } } },
          })
        ).map((fc) => fc.file.path),
      );
      conflicts = conflicts.filter((c) => !touched.has(c.path));
    }
    if (conflicts.length > 0) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          describeMergeConflicts(parentName, branchName, conflicts).replace(
            /^Cannot merge/,
            "Cannot bring",
          ) +
          `\nResolve them on ${branchName} (submit each resolved file there), then update again naming that changelist.`,
      });
    }

    const edits: TreeEdit[] = applied.map((change) =>
      change.incoming === null
        ? { path: change.path, delete: true as const }
        : { path: change.path, cl: change.incoming },
    );
    let fileCount = branchHead.fileCount;
    if (fileCount !== null) {
      for (const change of applied) {
        const atBranch = targetAt.has(change.path);
        if (change.incoming !== null && !atBranch) fileCount++;
        if (change.incoming === null && atBranch) fileCount--;
      }
    }

    const lastCl = await db.changelist.findFirst({
      where: { repoId },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const nextNumber = (lastCl?.number ?? -1) + 1;

    let stateRootHash: string;
    try {
      const repo = await db.repo.findUnique({
        where: { id: repoId },
        select: { pathPortability: true },
      });
      stateRootHash =
        applied.length === 0 && branchRoot
          ? branchRoot
          : await submitStateTree(
              db,
              repoId,
              branchHead.number,
              branchRoot,
              edits,
              { foldNames: repo?.pathPortability ?? true },
            );
    } catch (error) {
      if (error instanceof TreeCollisionError) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Cannot bring ${parentName} into ${branchName}: ${error.message}. Nothing was changed.`,
        });
      }
      if (!isSubmitContention(error)) {
        throw error;
      }
      continue;
    }

    const files = await db.file.findMany({
      where: { repoId, path: { in: applied.map((c) => c.path) } },
      select: { id: true, path: true },
    });
    const fileIdByPath = new Map(files.map((f) => [f.path, f.id]));

    try {
      const created = await db.$transaction(async (tx) => {
        const cl = await tx.changelist.create({
          data: {
            number: nextNumber,
            message: `Brought ${parentName} into ${branchName}`,
            versionIndex: "",
            parentNumber: branch.headNumber,
            mergedFromNumber: parent.headNumber,
            stateRootHash,
            fileCount,
            repoId,
            userId,
          },
        });
        const moved = await tx.branch.updateMany({
          where: {
            id: branch.id,
            headNumber: branch.headNumber,
            archivedAt: null,
          },
          data: { headNumber: nextNumber },
        });
        if (moved.count !== 1) {
          throw new SubmitContention(`the head of ${branchName} moved`);
        }
        const rows = applied.flatMap((change) => {
          const fileId = fileIdByPath.get(change.path);
          return fileId
            ? [
                {
                  repoId,
                  fileId,
                  changelistNumber: nextNumber,
                  type:
                    change.incoming === null
                      ? FileChangeType.DELETE
                      : FileChangeType.MODIFY,
                  sourceChangelistNumber: change.incoming,
                },
              ]
            : [];
        });
        for (let i = 0; i < rows.length; i += 20000) {
          await tx.fileChange.createMany({ data: rows.slice(i, i + 20000) });
        }
        return cl;
      });
      return {
        status: "updated",
        number: created.number,
        applied: applied.length,
      };
    } catch (error) {
      if (!isSubmitContention(error)) {
        throw error;
      }
    }
  }

  throw new TRPCError({
    code: "CONFLICT",
    message: `${branchName} kept moving while it was being updated; try again`,
  });
}
