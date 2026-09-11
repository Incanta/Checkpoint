import {
  ClaimEventType,
  ClaimState,
  type FileClaim,
  type PrismaClient,
} from "@prisma/client";

import { getStateTreePaths } from "~/server/state-tree";
import { resolveDomainBranchName } from "./domain";
import type { ClaimActor } from "./claims";

type Db = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

/**
 * Settles claims when a branch merges.
 *
 * Release when the merge target is its own domain root (the work has landed),
 * advance onto the target otherwise (the work moved one rung up a stack but is
 * still in flight). This is the same rule submit applies, which is why stacked
 * feature branches need no special case.
 *
 * The incoming file set is already computed by the caller, so this adds one
 * indexed lookup rather than a scan.
 */
export async function settleClaimsForMerge(
  db: Db,
  params: {
    repoId: string;
    incomingBranchName: string;
    targetBranchName: string;
    mergeChangelistNumber: number;
    /** Paths carried by the merge, normalized. */
    paths: string[];
    actor: Partial<ClaimActor>;
  },
): Promise<{ released: number; advanced: number }> {
  if (params.paths.length === 0) {
    return { released: 0, advanced: 0 };
  }

  const targetBranch = await db.branch.findUnique({
    where: { repoId_name: { repoId: params.repoId, name: params.targetBranchName } },
  });

  if (!targetBranch) {
    return { released: 0, advanced: 0 };
  }

  const targetDomain = await resolveDomainBranchName(
    db,
    params.repoId,
    targetBranch,
  );
  const targetIsDomainRoot = targetDomain === targetBranch.name;

  // Claims held on the incoming branch, or on anything that was stacked below
  // it and has already been advanced onto it.
  const claims = await db.fileClaim.findMany({
    where: {
      repoId: params.repoId,
      branchName: params.incomingBranchName,
      releasedAt: null,
      file: { path: { in: params.paths } },
    },
  });

  if (claims.length === 0) {
    return { released: 0, advanced: 0 };
  }

  const ids = claims.map((c) => c.id);

  if (targetIsDomainRoot) {
    await db.fileClaim.updateMany({
      where: { id: { in: ids } },
      data: {
        releasedAt: new Date(),
        releasedByChangelistNumber: params.mergeChangelistNumber,
        headChangelistNumber: params.mergeChangelistNumber,
      },
    });

    await db.fileClaimEvent.createMany({
      data: claims.map((c) => ({
        claimId: c.id,
        type: ClaimEventType.RELEASE,
        branchName: params.targetBranchName,
        userId: params.actor.userId ?? null,
        workspaceId: params.actor.workspaceId ?? null,
        changelistNumber: params.mergeChangelistNumber,
      })),
    });

    return { released: claims.length, advanced: 0 };
  }

  await db.fileClaim.updateMany({
    where: { id: { in: ids } },
    data: {
      branchName: params.targetBranchName,
      headChangelistNumber: params.mergeChangelistNumber,
      state: ClaimState.SUBMITTED,
    },
  });

  await db.fileClaimEvent.createMany({
    data: claims.map((c) => ({
      claimId: c.id,
      type: ClaimEventType.ADVANCE,
      branchName: params.targetBranchName,
      userId: params.actor.userId ?? null,
      workspaceId: params.actor.workspaceId ?? null,
      changelistNumber: params.mergeChangelistNumber,
    })),
  });

  return { released: 0, advanced: claims.length };
}

/**
 * Backstop for content that reaches a domain root by a route other than a
 * merge of the holding branch: a cherry-pick, or somebody submitting the same
 * path straight to the root.
 *
 * A claim releases when the domain root's head state maps its path to a
 * changelist at or after the claim's own head. Runs lazily over a set of claims
 * the caller is about to return, rather than as a background sweep.
 */
export async function reconcileClaims(
  db: Db,
  repoId: string,
  claims: (FileClaim & { file: { path: string } })[],
): Promise<Set<string>> {
  const released = new Set<string>();

  const candidates = claims.filter(
    (c) => c.releasedAt === null && c.headChangelistNumber !== null,
  );

  if (candidates.length === 0) {
    return released;
  }

  // Group by domain so each domain's head state is materialized once.
  const byDomain = new Map<string, typeof candidates>();
  for (const claim of candidates) {
    const bucket = byDomain.get(claim.domainBranchName) ?? [];
    bucket.push(claim);
    byDomain.set(claim.domainBranchName, bucket);
  }

  for (const [domainBranchName, domainClaims] of byDomain) {
    const domainBranch = await db.branch.findUnique({
      where: { repoId_name: { repoId, name: domainBranchName } },
      select: { headNumber: true },
    });

    if (!domainBranch) {
      continue;
    }

    let headState: Map<string, number>;
    try {
      headState = new Map(
        await getStateTreePaths(db as PrismaClient, repoId, domainBranch.headNumber),
      );
    } catch {
      // A repo with no state tree yet (test fixtures, fresh repos) simply has
      // nothing to reconcile against.
      continue;
    }

    const landed = domainClaims.filter((claim) => {
      const sourceNumber = headState.get(claim.file.path);
      return (
        sourceNumber !== undefined &&
        claim.headChangelistNumber !== null &&
        sourceNumber >= claim.headChangelistNumber
      );
    });

    if (landed.length === 0) {
      continue;
    }

    const now = new Date();
    await db.fileClaim.updateMany({
      where: { id: { in: landed.map((c) => c.id) } },
      data: { releasedAt: now },
    });

    await db.fileClaimEvent.createMany({
      data: landed.map((c) => ({
        claimId: c.id,
        type: ClaimEventType.RELEASE,
        branchName: c.branchName,
        changelistNumber: headState.get(c.file.path) ?? null,
      })),
    });

    for (const claim of landed) {
      released.add(claim.id);
    }
  }

  return released;
}
