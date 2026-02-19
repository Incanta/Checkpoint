import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { createOrgDirectory } from "~/server/storage-service";

export const orgRouter = createTRPCRouter({
  myOrgs: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.org.findMany({
      where: {
        deletedAt: null,
        users: {
          some: {
            userId: ctx.session.user.id,
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
          userId: ctx.session.user.id,
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
      const org = await ctx.db.org.create({
        data: {
          name: input.name,
        },
      });

      // Add the creator as an admin
      await ctx.db.orgUser.create({
        data: {
          orgId: org.id,
          userId: ctx.session.user.id,
          role: "ADMIN",
        },
      });

      // Create the org directory in storage
      try {
        await createOrgDirectory(org.id);
      } catch (error) {
        console.error("Failed to create org directory in storage:", error);
        // Note: We don't fail the org creation here since the DB record is created
        // The directory can be created later if needed
      }

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
      const { id, ...updateData } = input;

      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: id,
          userId: ctx.session.user.id,
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
      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: input.id,
          userId: ctx.session.user.id,
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
          deletedBy: ctx.session.user.id,
        },
      });
    }),

  addUserToOrg: protectedProcedure
    .input(
      z.object({
        orgId: z.string(),
        userEmail: z.string().email(),
        role: z.enum(["ADMIN", "MEMBER"]).default("MEMBER"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Check if the current user is an admin of the org
      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: input.orgId,
          userId: ctx.session.user.id,
        },
      });

      if (orgUser?.role !== "ADMIN") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "You do not have permission to add users to this organization",
        });
      }

      // Find the user to add by email
      const userToAdd = await ctx.db.user.findUnique({
        where: { email: input.userEmail },
      });

      if (!userToAdd) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "User with the specified email not found",
        });
      }

      // Check if user is already in the org
      const existingOrgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: input.orgId,
          userId: userToAdd.id,
        },
      });

      if (existingOrgUser) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "User is already a member of this organization",
        });
      }

      // Add the user to the org
      const newOrgUser = await ctx.db.orgUser.create({
        data: {
          orgId: input.orgId,
          userId: userToAdd.id,
          role: input.role,
        },
      });

      return newOrgUser;
    }),
});
