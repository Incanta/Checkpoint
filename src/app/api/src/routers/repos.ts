import { z } from 'zod'
import { router, protectedProcedure } from '../lib/trpc'

const createRepoInput = z.object({
  name: z.string(),
  orgId: z.string(),
  public: z.boolean().optional().default(false),
})

const updateRepoInput = z.object({
  name: z.string().optional(),
  public: z.boolean().optional(),
})

export const reposRouter = router({
  list: protectedProcedure
    .input(z.object({ orgId: z.string() }))
    .query(async ({ input, ctx }) => {
      // First get the org with repos to check permissions
      const org = await ctx.db.org.findFirst({
        where: { id: input.orgId },
        include: {
          repos: {
            include: {
              additionalRoles: true,
            },
          },
        },
      })

      if (!org) {
        return []
      }

      // Check if user is member of org
      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: input.orgId,
          userId: ctx.currentUser.id,
        },
      })

      if (!orgUser) {
        // Return only public repos
        return org.repos.filter((repo) => repo.public)
      }

      // Return repos based on access permissions
      return org.repos.filter(
        (repo) =>
          repo.public ||
          org.defaultRepoAccess !== "NONE" ||
          repo.additionalRoles.some(
            (role) =>
              role.userId === ctx.currentUser.id && role.access !== "NONE",
          ),
      )
    }),

  byId: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const repo = await ctx.db.repo.findUnique({
        where: { id: input.id },
        include: {
          org: true,
        },
      })

      if (!repo) {
        return null
      }

      if (repo.public) {
        return repo
      }

      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: repo.orgId,
          userId: ctx.currentUser.id,
        },
      })

      if (!orgUser) {
        return null
      }

      if (repo.org.defaultRepoAccess !== "NONE") {
        return repo
      }

      const repoRole = await ctx.db.repoRole.findFirst({
        where: {
          repoId: repo.id,
          userId: ctx.currentUser.id,
        },
      })

      if (!repoRole || repoRole.access === "NONE") {
        return null
      }

      return repo
    }),

  create: protectedProcedure
    .input(createRepoInput)
    .mutation(async ({ input, ctx }) => {
      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: input.orgId,
          userId: ctx.currentUser.id,
        },
        include: {
          org: true,
        },
      })

      if (!orgUser || (!orgUser.org.defaultCanCreateRepos && orgUser.role !== "ADMIN")) {
        throw new Error("User does not have permission to create a repo")
      }

      const repo = await ctx.db.repo.create({
        data: {
          public: false,
          ...input,
        },
      })

      // Create initial changelist
      await ctx.db.changelist.create({
        data: {
          number: 0,
          message: "Repo Creation",
          versionIndex: "",
          stateTree: {},
          repoId: repo.id,
          userId: ctx.currentUser.id,
        },
      })

      // Create main branch
      await ctx.db.branch.create({
        data: {
          name: "main",
          repoId: repo.id,
          headNumber: 0,
          isDefault: true,
        },
      })

      // Add admin role if user is member (not admin)
      if (orgUser.role === "MEMBER") {
        await ctx.db.repoRole.create({
          data: {
            access: "ADMIN",
            repoId: repo.id,
            userId: ctx.currentUser.id,
          },
        })
      }

      return repo
    }),

  update: protectedProcedure
    .input(z.object({
      id: z.string(),
      data: updateRepoInput,
    }))
    .mutation(async ({ input, ctx }) => {
      const repo = await ctx.db.repo.findUnique({
        where: { id: input.id },
        include: {
          org: true,
          additionalRoles: true,
        },
      })

      if (!repo) {
        throw new Error("Repo not found")
      }

      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: repo.orgId,
          userId: ctx.currentUser.id,
        },
      })

      const hasAdminAccess = orgUser && (
        orgUser.role === "ADMIN" ||
        repo.additionalRoles.some(role => 
          role.userId === ctx.currentUser.id && role.access === "ADMIN"
        )
      )

      if (!hasAdminAccess) {
        throw new Error("User does not have permission to update the repo")
      }

      return ctx.db.repo.update({
        where: { id: input.id },
        data: input.data,
      })
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const repo = await ctx.db.repo.findUnique({
        where: { id: input.id },
        include: {
          org: true,
          additionalRoles: true,
        },
      })

      if (!repo) {
        throw new Error("Repo not found")
      }

      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: repo.orgId,
          userId: ctx.currentUser.id,
        },
      })

      const hasAdminAccess = orgUser && (
        orgUser.role === "ADMIN" ||
        repo.additionalRoles.some(role => 
          role.userId === ctx.currentUser.id && role.access === "ADMIN"
        )
      )

      if (!hasAdminAccess) {
        throw new Error("User does not have permission to delete the repo")
      }

      return ctx.db.repo.update({
        where: { id: input.id },
        data: {
          deletedAt: new Date(),
          deletedBy: ctx.currentUser.id,
        },
      })
    }),

  restore: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.currentUser.checkpointAdmin) {
        throw new Error("You do not have permission to restore this repo")
      }

      return ctx.db.repo.update({
        data: { deletedAt: null, deletedBy: null },
        where: { id: input.id },
      })
    }),
})