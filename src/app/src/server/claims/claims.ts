import { TRPCError } from "@trpc/server";
import {
  ClaimEventType,
  ClaimState,
  ClaimStrength,
  type FileClaim,
  type PrismaClient,
} from "@prisma/client";

import { getBranchWithDomain, isBranchAtOrBelow } from "./domain";
import { resolveClaimStrength } from "./strength";

type Db = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export type ClaimActor = {
  userId: string;
  workspaceId: string;
};

/**
 * The exclusion lookup.
 *
 * Both predicates are spelled out so the planner uses the partial unique index
 * `FileClaim_active_exclusive` and never scans advisory rows, which are the
 * overwhelming majority: every checkout creates a claim, and most files are
 * text.
 */
export async function findActiveExclusiveClaim(
  db: Db,
  repoId: string,
  fileId: string,
  domainBranchName: string,
): Promise<FileClaim | null> {
  return db.fileClaim.findFirst({
    where: {
      repoId,
      fileId,
      domainBranchName,
      releasedAt: null,
      strength: ClaimStrength.EXCLUSIVE,
    },
  });
}

/** Batch form for the submit guard, which checks thousands of paths at once. */
export async function findActiveExclusiveClaimsForFiles(
  db: Db,
  repoId: string,
  fileIds: string[],
  domainBranchName: string,
): Promise<FileClaim[]> {
  if (fileIds.length === 0) {
    return [];
  }

  const BATCH_SIZE = 20000;
  const claims: FileClaim[] = [];

  for (let i = 0; i < fileIds.length; i += BATCH_SIZE) {
    const batch = fileIds.slice(i, i + BATCH_SIZE);
    const found = await db.fileClaim.findMany({
      where: {
        repoId,
        fileId: { in: batch },
        domainBranchName,
        releasedAt: null,
        strength: ClaimStrength.EXCLUSIVE,
      },
      include: {
        file: true,
        workspace: {
          include: {
            user: {
              select: { id: true, email: true, name: true, username: true },
            },
          },
        },
      },
    });
    claims.push(...found);
  }

  return claims;
}

async function logEvent(
  db: Db,
  claimId: string,
  type: ClaimEventType,
  branchName: string,
  actor: Partial<ClaimActor>,
  changelistNumber?: number | null,
): Promise<void> {
  await db.fileClaimEvent.create({
    data: {
      claimId,
      type,
      branchName,
      userId: actor.userId ?? null,
      workspaceId: actor.workspaceId ?? null,
      changelistNumber: changelistNumber ?? null,
    },
  });
}

export type AcquireResult = {
  claim: FileClaim;
  /** True when an existing SUBMITTED claim was taken over rather than created. */
  reclaimed: boolean;
};

/**
 * Takes (or reclaims) a claim on a path.
 *
 * Advisory acquisition is always granted: it creates an additional row
 * alongside any existing advisory claims on the same path, regardless of who
 * holds them or which branch they sit on, and it is never refused by the
 * freshness gate. Only exclusive claims are gated.
 */
export async function acquireClaim(
  db: Db,
  params: {
    repoId: string;
    fileId: string;
    filePath: string;
    branchName: string;
    orgBinaryExtensions: string;
    forceExclusive?: boolean;
    actor: ClaimActor;
    /**
     * The requester's synced changelist for this path. When provided and behind
     * the branch head, an exclusive acquisition is refused so the work never
     * starts against a stale binary.
     */
    syncedChangelistNumber?: number | null;
  },
): Promise<AcquireResult> {
  const { branch, domainBranchName } = await getBranchWithDomain(
    db,
    params.repoId,
    params.branchName,
  );

  const strength = resolveClaimStrength(
    params.filePath,
    params.orgBinaryExtensions,
    params.forceExclusive,
  );

  if (strength === ClaimStrength.ADVISORY) {
    const claim = await db.fileClaim.create({
      data: {
        repoId: params.repoId,
        fileId: params.fileId,
        domainBranchName,
        branchName: params.branchName,
        workspaceId: params.actor.workspaceId,
        strength,
        state: ClaimState.OPEN,
        baseChangelistNumber: branch.headNumber,
      },
    });

    await logEvent(
      db,
      claim.id,
      ClaimEventType.CLAIM,
      params.branchName,
      params.actor,
    );

    return { claim, reclaimed: false };
  }

  const existing = await findActiveExclusiveClaim(
    db,
    params.repoId,
    params.fileId,
    domainBranchName,
  );

  if (existing) {
    if (existing.state === ClaimState.OPEN) {
      if (existing.workspaceId === params.actor.workspaceId) {
        return { claim: existing, reclaimed: false };
      }

      throw new TRPCError({
        code: "CONFLICT",
        message: `"${params.filePath}" is checked out on "${existing.branchName}" and is being edited right now`,
      });
    }

    // SUBMITTED: reclaimable on the holding branch or anything stacked below
    // it, which is what lets a stacked branch continue its parent's work.
    const permitted = await isBranchAtOrBelow(
      db,
      params.repoId,
      params.branchName,
      existing.branchName,
    );

    if (!permitted) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `"${params.filePath}" is in flight on "${existing.branchName}" and cannot be claimed from "${params.branchName}" until it reaches "${domainBranchName}"`,
      });
    }

    assertFresh(params, existing.headChangelistNumber ?? branch.headNumber);

    const claim = await db.fileClaim.update({
      where: { id: existing.id },
      data: {
        state: ClaimState.OPEN,
        workspaceId: params.actor.workspaceId,
        branchName: params.branchName,
        baseChangelistNumber: existing.headChangelistNumber ?? branch.headNumber,
      },
    });

    await logEvent(
      db,
      claim.id,
      ClaimEventType.CLAIM,
      params.branchName,
      params.actor,
    );

    return { claim, reclaimed: true };
  }

  assertFresh(params, branch.headNumber);

  const claim = await db.fileClaim.create({
    data: {
      repoId: params.repoId,
      fileId: params.fileId,
      domainBranchName,
      branchName: params.branchName,
      workspaceId: params.actor.workspaceId,
      strength,
      state: ClaimState.OPEN,
      baseChangelistNumber: branch.headNumber,
    },
  });

  await logEvent(
    db,
    claim.id,
    ClaimEventType.CLAIM,
    params.branchName,
    params.actor,
  );

  return { claim, reclaimed: false };
}

/**
 * The freshness gate.
 *
 * Refusing here costs the user a sync. Refusing at submit instead, which is
 * what Perforce does for a `p4 edit` on a stale file, costs them the work,
 * because a .uasset has no resolve.
 *
 * The baseline is the head of the branch being claimed on, not the domain
 * root: reclaiming a SUBMITTED claim on a feature branch compares against that
 * branch's head, which is by definition ahead of the root's.
 */
function assertFresh(
  params: { filePath: string; syncedChangelistNumber?: number | null },
  requiredChangelistNumber: number,
): void {
  if (
    params.syncedChangelistNumber !== undefined &&
    params.syncedChangelistNumber !== null &&
    params.syncedChangelistNumber < requiredChangelistNumber
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `"${params.filePath}" has changed since you last synced (you are at ${params.syncedChangelistNumber}, latest is ${requiredChangelistNumber}). Sync before checking it out.`,
    });
  }
}

/**
 * Advances or releases a claim after its content moves to `targetBranchName`.
 *
 * The same test governs a submit and a merge: release when the work reaches the
 * domain root, advance otherwise. Advancing re-anchors `branchName` onto the
 * target rather than leaving it on the branch the work came from, which matters
 * because that branch is usually archived immediately afterward and an
 * ancestry-based release test would then be asking about branches that no
 * longer exist.
 */
export async function settleClaimAfterLanding(
  db: Db,
  claim: FileClaim,
  params: {
    targetBranchName: string;
    targetIsDomainRoot: boolean;
    changelistNumber: number;
    actor: Partial<ClaimActor>;
    /** Keeps an OPEN claim open instead of parking it as SUBMITTED. */
    keepCheckedOut?: boolean;
  },
): Promise<void> {
  if (params.targetIsDomainRoot) {
    if (params.keepCheckedOut) {
      await db.fileClaim.update({
        where: { id: claim.id },
        data: {
          branchName: params.targetBranchName,
          headChangelistNumber: params.changelistNumber,
          baseChangelistNumber: params.changelistNumber,
        },
      });
      return;
    }

    await db.fileClaim.update({
      where: { id: claim.id },
      data: {
        releasedAt: new Date(),
        releasedByChangelistNumber: params.changelistNumber,
        headChangelistNumber: params.changelistNumber,
      },
    });

    await logEvent(
      db,
      claim.id,
      ClaimEventType.RELEASE,
      params.targetBranchName,
      params.actor,
      params.changelistNumber,
    );
    return;
  }

  await db.fileClaim.update({
    where: { id: claim.id },
    data: {
      branchName: params.targetBranchName,
      headChangelistNumber: params.changelistNumber,
      state: params.keepCheckedOut ? ClaimState.OPEN : ClaimState.SUBMITTED,
    },
  });

  await logEvent(
    db,
    claim.id,
    claim.branchName === params.targetBranchName
      ? ClaimEventType.SUBMIT
      : ClaimEventType.ADVANCE,
    params.targetBranchName,
    params.actor,
    params.changelistNumber,
  );
}

/**
 * Settles every claim a submit touched, and creates claims for paths that
 * reached the submit without ever having been checked out.
 *
 * Because the daemon tracks dirty files whether or not anything was checked
 * out, submitting a never-claimed path is a common route rather than an edge
 * case. Claims are metadata: they never decide what goes into the changelist,
 * they only record and enforce.
 */
export async function settleClaimsForSubmit(
  db: Db,
  params: {
    repoId: string;
    branchName: string;
    domainBranchName: string;
    targetIsDomainRoot: boolean;
    changelistNumber: number;
    fileIdsForPaths: Record<string, string | undefined>;
    orgBinaryExtensions: string;
    keepCheckedOut: boolean;
    actor: ClaimActor;
  },
): Promise<void> {
  const entries = Object.entries(params.fileIdsForPaths).filter(
    (entry): entry is [string, string] => Boolean(entry[1]),
  );

  if (entries.length === 0) {
    return;
  }

  const fileIds = entries.map(([, fileId]) => fileId);

  const existing = await db.fileClaim.findMany({
    where: {
      repoId: params.repoId,
      domainBranchName: params.domainBranchName,
      fileId: { in: fileIds },
      releasedAt: null,
    },
  });

  const existingByFileId = new Map<string, FileClaim[]>();
  for (const claim of existing) {
    const bucket = existingByFileId.get(claim.fileId) ?? [];
    bucket.push(claim);
    existingByFileId.set(claim.fileId, bucket);
  }

  for (const [path, fileId] of entries) {
    const claims = existingByFileId.get(fileId) ?? [];

    // Only claims this workspace holds are settled. Anything else in the
    // domain was already rejected by the submit guard, or is advisory and
    // belongs to someone else's parallel work.
    const held = claims.filter(
      (c) => c.workspaceId === params.actor.workspaceId,
    );

    if (held.length > 0) {
      for (const claim of held) {
        await settleClaimAfterLanding(db, claim, {
          targetBranchName: params.branchName,
          targetIsDomainRoot: params.targetIsDomainRoot,
          changelistNumber: params.changelistNumber,
          actor: params.actor,
          keepCheckedOut: params.keepCheckedOut,
        });
      }
      continue;
    }

    // Never checked out. A submit straight to the domain root needs no claim
    // at all: it would be born already satisfied.
    if (params.targetIsDomainRoot) {
      continue;
    }

    const strength = resolveClaimStrength(path, params.orgBinaryExtensions);

    const claim = await db.fileClaim.create({
      data: {
        repoId: params.repoId,
        fileId,
        domainBranchName: params.domainBranchName,
        branchName: params.branchName,
        workspaceId: params.actor.workspaceId,
        strength,
        state: params.keepCheckedOut ? ClaimState.OPEN : ClaimState.SUBMITTED,
        baseChangelistNumber: params.changelistNumber,
        headChangelistNumber: params.changelistNumber,
      },
    });

    await logEvent(
      db,
      claim.id,
      ClaimEventType.SUBMIT,
      params.branchName,
      params.actor,
      params.changelistNumber,
    );
  }
}

/** Explicit release, used by undo-checkout and by revert. */
export async function releaseClaim(
  db: Db,
  claim: FileClaim,
  actor: Partial<ClaimActor>,
  type: ClaimEventType = ClaimEventType.RELEASE,
): Promise<void> {
  await db.fileClaim.update({
    where: { id: claim.id },
    data: { releasedAt: new Date() },
  });

  await logEvent(db, claim.id, type, claim.branchName, actor);
}

/**
 * Releases every active claim held on a branch. Used when a branch is
 * discarded or deleted.
 *
 * Both discard flavours release: the work is not reaching the domain root
 * either way, so holding the path hostage forever is wrong. Purgeability is a
 * separate question about content GC and has no bearing here.
 */
export async function releaseClaimsForBranch(
  db: Db,
  repoId: string,
  branchName: string,
  actor: Partial<ClaimActor>,
): Promise<number> {
  const claims = await db.fileClaim.findMany({
    where: { repoId, branchName, releasedAt: null },
    select: { id: true },
  });

  if (claims.length === 0) {
    return 0;
  }

  const now = new Date();
  await db.fileClaim.updateMany({
    where: { id: { in: claims.map((c) => c.id) } },
    data: { releasedAt: now },
  });

  await db.fileClaimEvent.createMany({
    data: claims.map((c) => ({
      claimId: c.id,
      type: ClaimEventType.DISCARD_RELEASE,
      branchName,
      userId: actor.userId ?? null,
      workspaceId: actor.workspaceId ?? null,
    })),
  });

  return claims.length;
}
