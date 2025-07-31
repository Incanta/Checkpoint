import { z } from 'zod'
import { router, protectedProcedure } from '../lib/trpc'
import { RepoAccess } from '@prisma/client'

const createOrgInput = z.object({
  name: z.string(),
  defaultRepoAccess: z.nativeEnum(RepoAccess).optional().default('WRITE'),
  defaultCanCreateRepos: z.boolean().optional().default(true),
})

const updateOrgInput = z.object({
  name: z.string().optional(),
  defaultRepoAccess: z.nativeEnum(RepoAccess).optional(),
  defaultCanCreateRepos: z.boolean().optional(),
})

const orgQueryInput = z.object({
  id: z.string(),
  idIsName: z.boolean().optional().default(false),
  includeUsers: z.boolean().optional().default(false),
  includeRepos: z.boolean().optional().default(false),
})

export const orgsRouter = router({
  myOrgs: protectedProcedure
    .query(async ({ ctx }) => {
      return ctx.db.org.findMany({
        where: {
          deletedAt: null,
          users: {
            some: {
              userId: ctx.currentUser.id,
            },
          },
        },
      })
    }),

  byId: protectedProcedure
    .input(orgQueryInput)
    .query(async ({ input, ctx }) => {
      const org = await ctx.db.org.findFirst({
        where: input.idIsName ? { name: input.id } : { id: input.id },
        include: {
          users: input.includeUsers || false,
          repos: input.includeRepos
            ? {
                include: {
                  additionalRoles: true,
                },
              }
            : false,
        },
      })

      if (!org) {
        return null
      }

      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: org.id,
          userId: ctx.currentUser.id,
        },
      })

      if (!orgUser) {
        // Return limited public information
        return {
          id: org.id,
          name: org.name,
          repos: org.repos?.filter((repo) => repo.public) || [],
        }
      }

      return {
        id: org.id,
        deletedAt: org.deletedAt,
        deletedBy: org.deletedBy,
        name: org.name,
        defaultRepoAccess: org.defaultRepoAccess,
        defaultCanCreateRepos: org.defaultCanCreateRepos,
        users: org.users,
        repos: org.repos?.filter(
          (repo) =>
            repo.public ||
            org.defaultRepoAccess !== "NONE" ||
            (repo as any).additionalRoles.some(
              (role: any) =>
                role.userId === orgUser.userId && role.access !== "NONE",
            ),
        ) || [],
      }
    }),

  create: protectedProcedure
    .input(createOrgInput)
    .mutation(async ({ input, ctx }) => {
      const org = await ctx.db.org.create({
        data: input,
      })

      await ctx.db.orgUser.create({
        data: {
          orgId: org.id,
          userId: ctx.currentUser.id,
          role: "ADMIN",
        },
      })

      return org
    }),

  update: protectedProcedure
    .input(z.object({
      id: z.string(),
      data: updateOrgInput,
    }))
    .mutation(async ({ input, ctx }) => {
      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: input.id,
          userId: ctx.currentUser.id,
        },
      })

      if (orgUser?.role !== "ADMIN") {
        throw new Error("You do not have permission to update this organization")
      }

      return ctx.db.org.update({
        data: input.data,
        where: { id: input.id },
      })
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: input.id,
          userId: ctx.currentUser.id,
        },
      })

      if (orgUser?.role !== "ADMIN") {
        throw new Error("You do not have permission to delete this organization")
      }

      return ctx.db.org.update({
        data: { deletedAt: new Date(), deletedBy: orgUser.userId },
        where: { id: input.id },
      })
    }),

  restore: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.currentUser.checkpointAdmin) {
        throw new Error("You do not have permission to restore this organization")
      }

      return ctx.db.org.update({
        data: { deletedAt: null, deletedBy: null },
        where: { id: input.id },
      })
    }),

  // Relation queries
  repos: protectedProcedure
    .input(z.object({ orgId: z.string() }))
    .query(async ({ input, ctx }) => {
      return ctx.db.repo.findMany({ 
        where: { orgId: input.orgId } 
      })
    }),
})