import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { createRepoDirectory, deleteRepoDirectory } from "~/server/storage-service";
import { RepoAccess } from "@prisma/client";
import { getUserAndRepoWithAccess } from "../auth-utils";
import { Logger } from "~/server/logging";

export const repoRouter = createTRPCRouter({
  getRepo: protectedProcedure
    .input(
      z.object({
        id: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.id,
        RepoAccess.READ,
      );

      return repo;
    }),

  getMyRepoAccess: protectedProcedure
    .input(z.object({ repoId: z.string() }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      const repo = await ctx.db.repo.findUnique({
        where: { id: input.repoId },
        include: {
          org: { include: { users: { where: { userId } } } },
          additionalRoles: { where: { userId } },
        },
      });

      if (!repo) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Repository not found",
        });
      }

      const orgUser = repo.org.users[0];
      const repoRole = repo.additionalRoles[0];

      const isMember = !!orgUser;

      const canWrite = !!(
        orgUser &&
        (repo.org.defaultRepoAccess === "WRITE" ||
          repo.org.defaultRepoAccess === "ADMIN" ||
          (repoRole &&
            (repoRole.access === "WRITE" || repoRole.access === "ADMIN")))
      );

      const isAdmin = !!(
        orgUser &&
        (orgUser.role === "ADMIN" ||
          repo.org.defaultRepoAccess === "ADMIN" ||
          repoRole?.access === "ADMIN")
      );

      return { isMember, canWrite, isAdmin };
    }),

  createRepo: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        orgId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: input.orgId,
          userId: ctx.session.user.id,
        },
        include: {
          org: true,
        },
      });

      if (
        !orgUser ||
        (!orgUser.org.defaultCanCreateRepos && orgUser.role !== "ADMIN")
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "User does not have permission to create a repo",
        });
      }

      const repo = await ctx.db.repo.create({
        data: {
          name: input.name,
          orgId: input.orgId,
          public: false,
        },
      });

      // Create initial changelist
      await ctx.db.changelist.create({
        data: {
          number: 0,
          message: "Repo Creation",
          versionIndex: "",
          stateTree: {},
          repoId: repo.id,
          userId: ctx.session.user.id,
        },
      });

      // Create main branch
      await ctx.db.branch.create({
        data: {
          name: "main",
          repoId: repo.id,
          headNumber: 0,
          isDefault: true,
          type: "MAINLINE",
          createdById: ctx.session.user.id,
        },
      });

      // If user is not an org admin, give them admin access to this repo
      if (orgUser.role === "MEMBER") {
        await ctx.db.repoRole.create({
          data: {
            access: "ADMIN",
            repoId: repo.id,
            userId: ctx.session.user.id,
          },
        });
      }

      // Create the repo directory in storage
      try {
        await createRepoDirectory(input.orgId, repo.id);
      } catch (error: any) {
        Logger.error(
          `Failed to create repo directory in storage: ${JSON.stringify(error)}`,
        );
        // rollback repo creation if directory creation fails
        await ctx.db.repoRole.deleteMany({ where: { repoId: repo.id } });
        await ctx.db.branch.deleteMany({ where: { repoId: repo.id } });
        await ctx.db.changelist.deleteMany({ where: { repoId: repo.id } });
        await ctx.db.repo.delete({ where: { id: repo.id } });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create storage for the repository",
        });
      }

      return repo;
    }),

  updateRepo: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        public: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.id, RepoAccess.ADMIN);

      const { id, ...updateData } = input;

      return ctx.db.repo.update({
        where: { id },
        data: updateData,
      });
    }),

  deleteRepo: protectedProcedure
    .input(
      z.object({
        id: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { repo } = await getUserAndRepoWithAccess(
        ctx,
        input.id,
        RepoAccess.ADMIN,
      );

      // Soft-delete the repo
      const deleted = await ctx.db.repo.update({
        where: { id: input.id },
        data: {
          name: `${repo.name}-deleted-${Date.now()}`,
          deletedAt: new Date(),
          deletedBy: ctx.session.user.id,
        },
      });

      // Clean up SeaweedFS directory immediately (non-R2 repos)
      if (!repo.r2BucketName) {
        try {
          await deleteRepoDirectory(repo.orgId, repo.id);
        } catch (err: unknown) {
          Logger.warn(
            `[Repo] Failed to delete storage directory for repo ${repo.id}: ${String(err)}`,
          );
        }
      }

      return deleted;
    }),

  list: protectedProcedure
    .input(
      z.object({
        orgId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: input.orgId,
          userId: ctx.session.user.id,
        },
      });

      if (!orgUser) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "User does not have access to this organization",
        });
      }

      const repos = await ctx.db.repo.findMany({
        where: {
          orgId: input.orgId,
          deletedAt: null,
        },
      });

      // Filter repos based on user access
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      const accessibleRepos = repos.filter((repo) => {
        if (repo.public) {
          return true;
        }

        if (orgUser.role !== "MEMBER") {
          return true;
        }

        // Check for additional repo roles
        return ctx.db.repoRole.findFirst({
          where: {
            repoId: repo.id,
            userId: ctx.session.user.id,
            access: { not: "NONE" },
          },
        });
      });

      return accessibleRepos;
    }),
});
