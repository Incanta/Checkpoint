import { z } from 'zod'
import { router, protectedProcedure } from '../lib/trpc'

export const workspacesRouter = router({
  list: protectedProcedure
    .query(async ({ ctx }) => {
      return ctx.db.workspace.findMany({
        where: { userId: ctx.currentUser.id },
      })
    }),

  byId: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      return ctx.db.workspace.findFirst({
        where: { 
          id: input.id,
          userId: ctx.currentUser.id,
        },
      })
    }),

  create: protectedProcedure
    .input(z.object({
      name: z.string(),
      repoId: z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      return ctx.db.workspace.create({
        data: {
          ...input,
          userId: ctx.currentUser.id,
        },
      })
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      return ctx.db.workspace.update({
        where: { 
          id: input.id,
          userId: ctx.currentUser.id,
        },
        data: { deletedAt: new Date() },
      })
    }),
})