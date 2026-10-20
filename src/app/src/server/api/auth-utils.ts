import type {
  User,
  RepoAccess,
  Repo,
  Org,
  OrgUser,
  RepoRole,
  PrismaClient,
} from "@prisma/client";
import type { TRPCContextPrivate } from "./trpc";
import { TRPCError } from "@trpc/server";

type RepoWithOrg = Repo & {
  org: Org & { users: OrgUser[] };
  additionalRoles: RepoRole[];
};

export async function getCheckpointUser(
  ctx: TRPCContextPrivate,
): Promise<User> {
  const user = await ctx.db.user.findUnique({
    where: { id: ctx.session.user.id },
  });

  if (!user) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Checkpoint user not found for this authenticated user",
    });
  }

  return user;
}

export async function getUserAndRepoWithAccess(
  ctx: TRPCContextPrivate,
  repoId: string,
  access: RepoAccess,
): Promise<{
  repo: RepoWithOrg;
  orgUser: OrgUser | null;
  repoRole: RepoRole | null;
  isAdmin: boolean;
}> {
  const userId = ctx.session.user.id;

  const repo = await ctx.db.repo.findUnique({
    where: { id: repoId },
    include: {
      org: {
        include: {
          users: { where: { userId } },
        },
      },
      additionalRoles: { where: { userId } },
    },
  });

  // A deleted repo, or any repo of a deleted org, is gone for every caller.
  // Both deletes are soft, so without this the rows (and the storage tokens
  // minted from them) stayed reachable by id after the delete.
  if (!repo || repo.deletedAt || repo.org.deletedAt) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Repository not found" });
  }

  if (repo.org.subscriptionStatus === "SUSPENDED") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Your organization's access is suspended due to unpaid invoices. Please contact your organization administrator to update your payment method or risk permanent data deletion.",
    });
  } else if (repo.org.subscriptionStatus === "DELETED") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Your organization's data has been deleted due to unpaid invoices.",
    });
  } else if (repo.org.subscriptionStatus === "CANCELED") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Your organization's subscription has been canceled. Please contact your organization administrator to resume your subscription or risk permanent data deletion.",
    });
  }

  const orgUser = repo.org.users[0];
  const repoRole = repo.additionalRoles[0];
  let isAdmin = false;

  if (access === "READ") {
    if (!hasReadAccess(repo, orgUser, repoRole)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You do not have access to this repository",
      });
    }
  } else if (access === "WRITE") {
    const hasWriteAccess =
      orgUser &&
      (orgUser.role === "ADMIN" ||
        repo.org.defaultRepoAccess === "WRITE" ||
        repo.org.defaultRepoAccess === "ADMIN" ||
        (repoRole &&
          (repoRole.access === "WRITE" || repoRole.access === "ADMIN")));

    if (!hasWriteAccess) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You do not have access to this repository",
      });
    }
  } else if (access === "ADMIN") {
    isAdmin = !!(
      orgUser &&
      (orgUser.role === "ADMIN" ||
        repo.org.defaultRepoAccess === "ADMIN" ||
        repoRole?.access === "ADMIN")
    );

    if (!isAdmin) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You do not have access to this repository",
      });
    }
  }

  return {
    repo,
    orgUser: orgUser ?? null,
    repoRole: repoRole ?? null,
    isAdmin,
  };
}

/**
 * The READ rule of getUserAndRepoWithAccess, on rows already loaded. Shared
 * with usersWithRepoRead so the two cannot drift apart.
 */
function hasReadAccess(
  repo: Pick<Repo, "public"> & { org: Pick<Org, "defaultRepoAccess"> },
  orgUser: Pick<OrgUser, "role"> | undefined,
  repoRole: Pick<RepoRole, "access"> | undefined,
): boolean {
  return !!(
    repo.public ||
    orgUser?.role === "ADMIN" ||
    (repo.org.defaultRepoAccess !== "NONE" && orgUser) ||
    (repoRole && repoRole.access !== "NONE")
  );
}

/**
 * The subset of `userIds` who may currently read the repo. Used wherever the
 * server sends repo content to users other than the caller (notifications,
 * assignees, reviewers), so a mention, an assignment, or a stale
 * subscription cannot deliver a private repo's titles and comments to someone
 * outside it.
 */
export async function usersWithRepoRead(
  db: PrismaClient,
  repoId: string,
  userIds: string[],
): Promise<Set<string>> {
  const allowed = new Set<string>();
  if (userIds.length === 0) return allowed;

  const repo = await db.repo.findUnique({
    where: { id: repoId },
    include: {
      org: { include: { users: { where: { userId: { in: userIds } } } } },
      additionalRoles: { where: { userId: { in: userIds } } },
    },
  });
  if (!repo || repo.deletedAt || repo.org.deletedAt) return allowed;

  for (const userId of userIds) {
    const orgUser = repo.org.users.find((u) => u.userId === userId);
    const repoRole = repo.additionalRoles.find((r) => r.userId === userId);
    if (hasReadAccess(repo, orgUser, repoRole)) {
      allowed.add(userId);
    }
  }
  return allowed;
}

/**
 * Throws unless the user may merge into the target branch under the repo's
 * merge permissions. An empty list for the branch's permission type means
 * every writer may merge. Every route that merges into a branch must call
 * this; a merge request and a direct branch merge land the same changelist.
 */
export async function assertMergePermission(
  db: PrismaClient,
  opts: {
    repoId: string;
    userId: string;
    targetBranchName: string;
    mergePermissionsSame: boolean;
  },
): Promise<void> {
  const targetBranch = await db.branch.findUnique({
    where: {
      repoId_name: { repoId: opts.repoId, name: opts.targetBranchName },
    },
    select: { type: true },
  });
  if (!targetBranch) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Target branch no longer exists",
    });
  }

  const permType = opts.mergePermissionsSame
    ? "MAINLINE"
    : targetBranch.type === "RELEASE"
      ? "RELEASE"
      : "MAINLINE";

  const permissions = await db.mergePermission.findMany({
    where: { repoId: opts.repoId, type: permType },
    select: { userId: true },
  });

  if (
    permissions.length > 0 &&
    !permissions.some((p) => p.userId === opts.userId)
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You are not authorized to merge into this branch",
    });
  }
}

/**
 * Throws unless the workspace belongs to the caller and, when `repoId` is
 * given, to that repo. Without the repo check a caller's workspace from one
 * repo could be passed to another's procedures, attaching claims there to a
 * workspace that has nothing to do with it (and reading claims back through a
 * repo the caller can still see).
 */
export async function assertWorkspaceOwnership(
  ctx: TRPCContextPrivate,
  workspaceId: string,
  repoId?: string,
): Promise<void> {
  const workspace = await ctx.db.workspace.findUnique({
    where: {
      id: workspaceId,
      userId: ctx.session.user.id,
      ...(repoId !== undefined && { repoId }),
    },
  });

  if (!workspace) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Workspace not found",
    });
  }
}
