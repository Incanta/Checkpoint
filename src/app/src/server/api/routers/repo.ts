import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { createRepoDirectory } from "~/server/storage-service";
import { RepoAccess } from "@prisma/client";
import { getUserAndRepoWithAccess } from "../auth-utils";

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
      } catch (error) {
        console.error("Failed to create repo directory in storage:", error);
        // Note: We don't fail the repo creation here since the DB record is created
        // The directory can be created later if needed
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
      await getUserAndRepoWithAccess(ctx, input.id, RepoAccess.ADMIN);

      return ctx.db.repo.update({
        where: { id: input.id },
        data: {
          deletedAt: new Date(),
          deletedBy: ctx.session.user.id,
        },
      });
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

      return await Promise.all(accessibleRepos);
    }),
});
