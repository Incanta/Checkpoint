import { z } from "zod";
import { TRPCError } from "@trpc/server";

import {
  createTRPCRouter,
  protectedProcedure,
} from "~/server/api/trpc";

export const repoRouter = createTRPCRouter({
  getRepo: protectedProcedure
    .input(z.object({
      id: z.string(),
    }))
    .query(async ({ ctx, input }) => {
      // Find the Checkpoint user associated with this NextAuth user
      const checkpointUser = await ctx.db.user.findUnique({
        where: { email: ctx.session.user.email! },
      });

      if (!checkpointUser) {
        throw new TRPCError({ 
          code: "NOT_FOUND", 
          message: "Checkpoint user not found for this authenticated user" 
        });
      }

      const repo = await ctx.db.repo.findUnique({
        where: { id: input.id },
        include: {
          org: true,
        },
      });

      if (!repo) {
        return null;
      }

      if (repo.public) {
        return repo;
      }

      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: repo.orgId,
          userId: checkpointUser.id,
        },
      });

      if (!orgUser) {
        return null;
      }

      if (repo.org.defaultRepoAccess !== "NONE") {
        return repo;
      }

      const repoRole = await ctx.db.repoRole.findFirst({
        where: {
          repoId: repo.id,
          userId: checkpointUser.id,
        },
      });

      if (!repoRole || repoRole.access === "NONE") {
        return null;
      }

      return repo;
    }),

  createRepo: protectedProcedure
    .input(z.object({
      name: z.string().min(1),
      orgId: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Find the Checkpoint user associated with this NextAuth user
      const checkpointUser = await ctx.db.user.findUnique({
        where: { email: ctx.session.user.email! },
      });

      if (!checkpointUser) {
        throw new TRPCError({ 
          code: "NOT_FOUND", 
          message: "Checkpoint user not found for this authenticated user" 
        });
      }

      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: input.orgId,
          userId: checkpointUser.id,
        },
        include: {
          org: true,
        },
      });

      if (!orgUser || (!orgUser.org.defaultCanCreateRepos && orgUser.role !== "ADMIN")) {
        throw new TRPCError({ 
          code: "FORBIDDEN", 
          message: "User does not have permission to create a repo" 
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
          userId: checkpointUser.id,
        },
      });

      // Create main branch
      await ctx.db.branch.create({
        data: {
          name: "main",
          repoId: repo.id,
          headNumber: 0,
          isDefault: true,
        },
      });

      // If user is not an org admin, give them admin access to this repo
      if (orgUser.role === "MEMBER") {
        await ctx.db.repoRole.create({
          data: {
            access: "ADMIN",
            repoId: repo.id,
            userId: checkpointUser.id,
          },
        });
      }

      return repo;
    }),

  updateRepo: protectedProcedure
    .input(z.object({
      id: z.string(),
      name: z.string().optional(),
      public: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Find the Checkpoint user associated with this NextAuth user
      const checkpointUser = await ctx.db.user.findUnique({
        where: { email: ctx.session.user.email! },
      });

      if (!checkpointUser) {
        throw new TRPCError({ 
          code: "NOT_FOUND", 
          message: "Checkpoint user not found for this authenticated user" 
        });
      }

      const { id, ...updateData } = input;

      const repo = await ctx.db.repo.findUnique({
        where: { id },
        include: {
          org: true,
          additionalRoles: true,
        },
      });

      if (!repo) {
        throw new TRPCError({ 
          code: "NOT_FOUND", 
          message: "Repo not found" 
        });
      }

      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: repo.orgId,
          userId: checkpointUser.id,
        },
      });

      const hasAdminAccess = 
        orgUser?.role === "ADMIN" ||
        repo.additionalRoles.some(
          (role) => role.userId === checkpointUser.id && role.access === "ADMIN"
        );

      if (!hasAdminAccess) {
        throw new TRPCError({ 
          code: "FORBIDDEN", 
          message: "User does not have permission to update the repo" 
        });
      }

      return ctx.db.repo.update({
        where: { id },
        data: updateData,
      });
    }),

  deleteRepo: protectedProcedure
    .input(z.object({
      id: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Find the Checkpoint user associated with this NextAuth user
      const checkpointUser = await ctx.db.user.findUnique({
        where: { email: ctx.session.user.email! },
      });

      if (!checkpointUser) {
        throw new TRPCError({ 
          code: "NOT_FOUND", 
          message: "Checkpoint user not found for this authenticated user" 
        });
      }

      const repo = await ctx.db.repo.findUnique({
        where: { id: input.id },
        include: {
          org: true,
          additionalRoles: true,
        },
      });

      if (!repo) {
        throw new TRPCError({ 
          code: "NOT_FOUND", 
          message: "Repo not found" 
        });
      }

      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: repo.orgId,
          userId: checkpointUser.id,
        },
      });

      const hasAdminAccess = 
        orgUser?.role === "ADMIN" ||
        repo.additionalRoles.some(
          (role) => role.userId === checkpointUser.id && role.access === "ADMIN"
        );

      if (!hasAdminAccess) {
        throw new TRPCError({ 
          code: "FORBIDDEN", 
          message: "User does not have permission to delete the repo" 
        });
      }

      return ctx.db.repo.update({
        where: { id: input.id },
        data: {
          deletedAt: new Date(),
          deletedBy: checkpointUser.id,
        },
      });
    }),
});