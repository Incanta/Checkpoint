import { z } from 'zod'
import { router, protectedProcedure } from '../lib/trpc'

export const fileCheckoutsRouter = router({
  list: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input, ctx }) => {
      return ctx.db.fileCheckout.findMany({
        where: { workspaceId: input.workspaceId },
      })
    }),

  create: protectedProcedure
    .input(z.object({
      fileId: z.string(),
      workspaceId: z.string(),
      locked: z.boolean().optional().default(false),
    }))
    .mutation(async ({ input, ctx }) => {
      return ctx.db.fileCheckout.create({
        data: input,
      })
    }),

  remove: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      return ctx.db.fileCheckout.update({
        where: { id: input.id },
        data: { removedAt: new Date() },
      })
    }),
})