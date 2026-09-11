import { TRPCError } from "@trpc/server";
import type { Branch, PrismaClient } from "@prisma/client";

/**
 * Accepts either the root client or an interactive-transaction client, so
 * claim helpers can be composed inside a submit or merge transaction.
 */
type Db = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

/**
 * Resolves a branch to its claim domain root: the nearest ancestor
 * (including itself) with `isClaimDomainRoot`.
 *
 * `Branch.domainBranchName` is denormalized at creation, so this is normally a
 * field read rather than a walk. The walk only runs for rows that predate the
 * column and were somehow missed by the migration backfill.
 */
export async function resolveDomainBranchName(
  db: Db,
  repoId: string,
  branch: Pick<
    Branch,
    "name" | "isClaimDomainRoot" | "domainBranchName" | "parentBranchName"
  >,
): Promise<string> {
  if (branch.domainBranchName) {
    return branch.domainBranchName;
  }

  if (branch.isClaimDomainRoot) {
    return branch.name;
  }

  // Fallback walk. Bounded by the branch depth, which stacking makes >1 but
  // never deep in practice; the loop guard is here so a cycle introduced by a
  // bad restack cannot hang a request.
  let current = branch;
  for (let hops = 0; hops < 64; hops++) {
    if (current.isClaimDomainRoot) {
      return current.name;
    }

    if (!current.parentBranchName) {
      // A non-root branch with no parent is malformed; treat it as its own
      // domain rather than failing the caller's operation outright.
      return current.name;
    }

    const parent: Pick<
      Branch,
      "name" | "isClaimDomainRoot" | "domainBranchName" | "parentBranchName"
    > | null = await db.branch.findUnique({
      where: { repoId_name: { repoId, name: current.parentBranchName } },
      select: {
        name: true,
        isClaimDomainRoot: true,
        domainBranchName: true,
        parentBranchName: true,
      },
    });

    if (!parent) {
      return current.name;
    }

    if (parent.domainBranchName) {
      return parent.domainBranchName;
    }

    current = parent;
  }

  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: `Could not resolve a claim domain for branch "${branch.name}" (parent chain too deep or cyclic)`,
  });
}

/** Loads a branch and resolves its domain in one step. */
export async function getBranchWithDomain(
  db: Db,
  repoId: string,
  branchName: string,
): Promise<{ branch: Branch; domainBranchName: string }> {
  const branch = await db.branch.findUnique({
    where: { repoId_name: { repoId, name: branchName } },
  });

  if (!branch) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Branch "${branchName}" not found in the repo`,
    });
  }

  return {
    branch,
    domainBranchName: await resolveDomainBranchName(db, repoId, branch),
  };
}

/**
 * Computes what a new branch's denormalized domain should be, given its parent.
 *
 * A branch that anchors its own domain is its own root. Otherwise it inherits
 * the parent's, which is what makes a stack of feature branches all resolve to
 * the same mainline or release root however deep it goes.
 */
export function computeDomainForNewBranch(
  name: string,
  isClaimDomainRoot: boolean,
  parent: Pick<Branch, "name" | "domainBranchName" | "isClaimDomainRoot"> | null,
): string {
  if (isClaimDomainRoot || !parent) {
    return name;
  }

  return parent.domainBranchName ?? parent.name;
}

/**
 * Re-parents every branch stacked on `mergedBranchName` onto its parent.
 *
 * Required, not cosmetic. `mergeBranch` only accepts a branch merging into its
 * own parent, and refuses an archived target, so once a parent merges and goes
 * away anything stacked on it can never merge anywhere. Domains never change
 * here: a branch and its parent are always in the same domain by construction.
 */
export async function restackChildren(
  db: Db,
  params: {
    repoId: string;
    mergedBranchName: string;
    newParentBranchName: string;
  },
): Promise<number> {
  const children = await db.branch.findMany({
    where: {
      repoId: params.repoId,
      parentBranchName: params.mergedBranchName,
    },
    select: { id: true },
  });

  if (children.length === 0) {
    return 0;
  }

  await db.branch.updateMany({
    where: { id: { in: children.map((c) => c.id) } },
    data: { parentBranchName: params.newParentBranchName },
  });

  return children.length;
}

/**
 * Resolves which branch a workspace operation applies to.
 *
 * An explicit branch wins, but must be one the workspace actually has active
 * (or its domain root) so a client cannot claim on a branch it has not
 * materialized. With no explicit branch, the workspace's domain root is the
 * answer, which is what a workspace with an empty active set is always doing.
 */
export async function resolveWorkspaceBranch(
  db: Db,
  repoId: string,
  workspace: { id: string; domainBranchName: string | null },
  requestedBranchName?: string,
): Promise<string> {
  const domainBranchName =
    workspace.domainBranchName ?? (await getDefaultBranchName(db, repoId));

  if (!requestedBranchName || requestedBranchName === domainBranchName) {
    return domainBranchName;
  }

  const active = await db.workspaceBranch.findUnique({
    where: {
      workspaceId_branchName: {
        workspaceId: workspace.id,
        branchName: requestedBranchName,
      },
    },
  });

  if (!active) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Branch "${requestedBranchName}" is not active in this workspace. Activate it before working on it.`,
    });
  }

  return requestedBranchName;
}

/**
 * Fallback for workspaces that predate server-side branch state, and for the
 * migration window before the daemon has reported in.
 */
export async function getDefaultBranchName(
  db: Db,
  repoId: string,
): Promise<string> {
  const defaultBranch = await db.branch.findFirst({
    where: { repoId, isDefault: true },
    select: { name: true },
  });

  if (defaultBranch) {
    return defaultBranch.name;
  }

  const anyMainline = await db.branch.findFirst({
    where: { repoId, isClaimDomainRoot: true, archivedAt: null },
    select: { name: true },
    orderBy: { name: "asc" },
  });

  if (!anyMainline) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "This repo has no domain-root branch to claim against",
    });
  }

  return anyMainline.name;
}

/**
 * True when `candidate` is `ancestor` or sits below it in the branch tree.
 *
 * Used by claim acquisition: a SUBMITTED claim may be reclaimed on the branch
 * holding it or on anything stacked beneath that branch, which is what lets a
 * stacked branch build on its parent's unreviewed work.
 */
export async function isBranchAtOrBelow(
  db: Db,
  repoId: string,
  candidateName: string,
  ancestorName: string,
): Promise<boolean> {
  if (candidateName === ancestorName) {
    return true;
  }

  let currentName: string | null = candidateName;

  for (let hops = 0; hops < 64 && currentName; hops++) {
    const current: { parentBranchName: string | null } | null =
      await db.branch.findUnique({
        where: { repoId_name: { repoId, name: currentName } },
        select: { parentBranchName: true },
      });

    if (!current?.parentBranchName) {
      return false;
    }

    if (current.parentBranchName === ancestorName) {
      return true;
    }

    currentName = current.parentBranchName;
  }

  return false;
}
