import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { createRepoDirectory } from "~/server/storage-service";
import { isR2Enabled, createR2Bucket } from "~/server/r2-service";
import { getEffectiveTier } from "~/server/license-client";
import { hasFeature } from "~/server/license-utils";
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
        (repo.org.defaultRepoAccess === "ADMIN" ||
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

      // Create storage for the repo (R2 bucket or SeaweedFS directory)
      if (isR2Enabled()) {
        const tier = await getEffectiveTier(input.orgId, ctx.db);
        if (hasFeature(tier, "r2Storage")) {
          const bucketName = `checkpoint-${repo.id}`;
          try {
            await createR2Bucket(bucketName);
            await ctx.db.repo.update({
              where: { id: repo.id },
              data: { r2BucketName: bucketName },
            });
          } catch (error) {
            console.error("Failed to create R2 bucket:", error);
          }
        } else {
          // Org/instance doesn't have R2 feature, fall back to SeaweedFS
          try {
            await createRepoDirectory(input.orgId, repo.id);
          } catch (error) {
            console.error("Failed to create repo directory in storage:", error);
          }
        }
      } else {
        // R2 not enabled, use SeaweedFS
        try {
          await createRepoDirectory(input.orgId, repo.id);
        } catch (error) {
          console.error("Failed to create repo directory in storage:", error);
        }
      }

      return repo;
    }),

  updateRepo: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        public: z.boolean().optional(),
        requiredReviews: z.number().min(0).optional(),
        mergePermissionsSame: z.boolean().optional(),
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

      return accessibleRepos;
    }),

  getMergePermissions: protectedProcedure
    .input(z.object({ repoId: z.string() }))
    .query(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.ADMIN);

      return ctx.db.mergePermission.findMany({
        where: { repoId: input.repoId },
        include: {
          user: { select: { id: true, name: true, email: true, image: true } },
        },
      });
    }),

  setMergePermissions: protectedProcedure
    .input(
      z.object({
        repoId: z.string(),
        type: z.enum(["MAINLINE", "RELEASE"]),
        userEmails: z.array(z.string().email()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await getUserAndRepoWithAccess(ctx, input.repoId, RepoAccess.ADMIN);

      // Resolve emails to user IDs
      const users = await ctx.db.user.findMany({
        where: { email: { in: input.userEmails } },
        select: { id: true, email: true },
      });

      // Delete existing permissions for this type
      await ctx.db.mergePermission.deleteMany({
        where: { repoId: input.repoId, type: input.type },
      });

      // Create new permissions
      if (users.length > 0) {
        await ctx.db.mergePermission.createMany({
          data: users.map((u) => ({
            repoId: input.repoId,
            userId: u.id,
            type: input.type,
          })),
        });
      }

      return { count: users.length };
    }),
});
