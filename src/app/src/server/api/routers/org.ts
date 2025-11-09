import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";

export const orgRouter = createTRPCRouter({
  myOrgs: protectedProcedure.query(async ({ ctx }) => {
    // Find the Checkpoint user associated with this NextAuth user
    const checkpointUser = await ctx.db.user.findUnique({
      where: { id: ctx.session.user.id },
    });

    if (!checkpointUser) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Checkpoint user not found for this authenticated user",
      });
    }

    return ctx.db.org.findMany({
      where: {
        deletedAt: null,
        users: {
          some: {
            userId: checkpointUser.id,
          },
        },
      },
      include: {
        repos: {
          where: {
            deletedAt: null,
          },
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
  }),

  getOrg: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        idIsName: z.boolean().default(false),
        includeUsers: z.boolean().default(false),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Find the Checkpoint user associated with this NextAuth user
      const checkpointUser = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
      });

      if (!checkpointUser) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Checkpoint user not found for this authenticated user",
        });
      }

      const org = await ctx.db.org.findFirst({
        where: input.idIsName ? { name: input.id } : { id: input.id },
        include: {
          users: input.includeUsers,
          repos: {
            include: {
              additionalRoles: true,
            },
          },
        },
      });

      if (!org) {
        return null;
      }

      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: org.id,
          userId: checkpointUser.id,
        },
      });

      if (!orgUser) {
        // Return only public repos if user is not a member
        return {
          id: org.id,
          name: org.name,
          repos: org.repos?.filter((repo) => repo.public) || [],
        };
      }

      // Filter repos based on access permissions
      const filteredRepos =
        org.repos?.filter(
          (repo) =>
            repo.public ||
            org.defaultRepoAccess !== "NONE" ||
            repo.additionalRoles.some(
              (role) =>
                role.userId === orgUser.userId && role.access !== "NONE",
            ),
        ) || [];

      return {
        ...org,
        repos: filteredRepos,
      };
    }),

  createOrg: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Find the Checkpoint user associated with this NextAuth user
      const checkpointUser = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
      });

      if (!checkpointUser) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Checkpoint user not found for this authenticated user",
        });
      }

      const org = await ctx.db.org.create({
        data: {
          name: input.name,
        },
      });

      // Add the creator as an admin
      await ctx.db.orgUser.create({
        data: {
          orgId: org.id,
          userId: checkpointUser.id,
          role: "ADMIN",
        },
      });

      return org;
    }),

  updateOrg: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        defaultRepoAccess: z
          .enum(["NONE", "READ", "WRITE", "ADMIN"])
          .optional(),
        defaultCanCreateRepos: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Find the Checkpoint user associated with this NextAuth user
      const checkpointUser = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
      });

      if (!checkpointUser) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Checkpoint user not found for this authenticated user",
        });
      }

      const { id, ...updateData } = input;

      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: id,
          userId: checkpointUser.id,
        },
      });

      if (orgUser?.role !== "ADMIN") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not have permission to update this organization",
        });
      }

      return ctx.db.org.update({
        where: { id },
        data: updateData,
      });
    }),

  deleteOrg: protectedProcedure
    .input(
      z.object({
        id: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Find the Checkpoint user associated with this NextAuth user
      const checkpointUser = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
      });

      if (!checkpointUser) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Checkpoint user not found for this authenticated user",
        });
      }

      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: input.id,
          userId: checkpointUser.id,
        },
      });

      if (orgUser?.role !== "ADMIN") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not have permission to delete this organization",
        });
      }

      return ctx.db.org.update({
        where: { id: input.id },
        data: {
          deletedAt: new Date(),
          deletedBy: checkpointUser.id,
        },
      });
    }),
});
