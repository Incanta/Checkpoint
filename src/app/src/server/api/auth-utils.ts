import type { User, RepoAccess } from "@prisma/client";
import type { TRPCContextPrivate } from "./trpc";
import { TRPCError } from "@trpc/server";

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
  repo: NonNullable<Awaited<ReturnType<typeof ctx.db.repo.findUnique>>>;
  orgUser: Awaited<ReturnType<typeof ctx.db.orgUser.findFirst>> | null;
  repoRole: Awaited<ReturnType<typeof ctx.db.repoRole.findFirst>> | null;
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

  if (!repo) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Repository not found" });
  }

  const orgUser = repo.org.users[0];
  const repoRole = repo.additionalRoles[0];
  let isAdmin = false;

  if (access === "READ") {
    const hasAccess =
      repo.public ||
      (repo.org.defaultRepoAccess !== "NONE" && orgUser) ||
      (repoRole && repoRole.access !== "NONE");

    if (!hasAccess) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You do not have access to this repository",
      });
    }
  } else if (access === "WRITE") {
    const hasWriteAccess =
      orgUser &&
      (repo.org.defaultRepoAccess === "WRITE" ||
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
      (repo.org.defaultRepoAccess === "ADMIN" ||
        (repoRole && repoRole.access === "ADMIN"))
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

export async function assertWorkspaceOwnership(
  ctx: TRPCContextPrivate,
  workspaceId: string,
): Promise<void> {
  const workspace = await ctx.db.workspace.findUnique({
    where: { id: workspaceId, userId: ctx.session.user.id },
  });

  if (!workspace) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Workspace not found",
    });
  }
}
