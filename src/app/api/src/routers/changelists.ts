import { z } from 'zod'
import { router, protectedProcedure } from '../lib/trpc'

// Manual enum definitions until Prisma client is generated
const FileChangeType = {
  ADDED: 'ADDED',
  MODIFIED: 'MODIFIED',
  DELETED: 'DELETED',
  RENAMED: 'RENAMED'
} as const

const modificationInput = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  type: z.enum(['ADDED', 'MODIFIED', 'DELETED', 'RENAMED']),
})

const createChangelistInput = z.object({
  repoId: z.string(),
  message: z.string(),
  parentNumber: z.number().optional(),
  modifications: z.array(modificationInput),
})

export const changelistsRouter = router({
  byId: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      return ctx.db.changelist.findUnique({
        where: { id: input.id },
      })
    }),

  list: protectedProcedure
    .input(z.object({ 
      repoId: z.string(), 
      numbers: z.array(z.number()) 
    }))
    .query(async ({ input, ctx }) => {
      return ctx.db.changelist.findMany({
        where: {
          repoId: input.repoId,
          number: {
            in: input.numbers,
          },
        },
      })
    }),

  create: protectedProcedure
    .input(createChangelistInput)
    .mutation(async ({ input, ctx }) => {
      // Check repo access
      const repo = await ctx.db.repo.findUnique({
        where: { id: input.repoId },
        include: {
          org: true,
        },
      })

      if (!repo) {
        throw new Error(`Repo ${input.repoId} not found`)
      }

      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: repo.orgId,
          userId: ctx.currentUser.id,
        },
      })

      if (!orgUser) {
        throw new Error(`User is not in the repo's org`)
      }

      // Check write access
      if (repo.org.defaultRepoAccess === "NONE" || repo.org.defaultRepoAccess === "READ") {
        const repoRole = await ctx.db.repoRole.findFirst({
          where: {
            repoId: repo.id,
            userId: ctx.currentUser.id,
          },
        })

        if (!repoRole || repoRole.access === "NONE" || repoRole.access === "READ") {
          throw new Error(`User does not have write access to repo`)
        }
      }

      // Get next changelist number
      const lastChangelist = await ctx.db.changelist.findFirst({
        where: { repoId: input.repoId },
        orderBy: { number: 'desc' },
      })

      const nextNumber = (lastChangelist?.number ?? 0) + 1

      // Create changelist
      const changelist = await ctx.db.changelist.create({
        data: {
          number: nextNumber,
          message: input.message,
          versionIndex: "", // TODO: implement version indexing
          stateTree: {}, // TODO: implement state tree
          repoId: input.repoId,
          userId: ctx.currentUser.id,
          parentNumber: input.parentNumber,
        },
      })

      // Handle file modifications
      for (const modification of input.modifications) {
        let file = await ctx.db.file.findFirst({
          where: {
            repoId: input.repoId,
            path: modification.oldPath || modification.path,
          },
        })

        if (!file && modification.type === 'ADD') {
          file = await ctx.db.file.create({
            data: {
              path: modification.path,
              repoId: input.repoId,
            },
          })
        }

        if (file) {
          await ctx.db.fileChange.create({
            data: {
              fileId: file.id,
              repoId: input.repoId,
              changelistNumber: changelist.number,
              type: modification.type,
              oldPath: modification.oldPath,
            },
          })
        }
      }

      return changelist
    }),
})