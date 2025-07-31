import { z } from 'zod'
import { router, protectedProcedure } from '../lib/trpc'

export const filesRouter = router({
  byId: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      return ctx.db.file.findUnique({
        where: { id: input.id },
      })
    }),

  list: protectedProcedure
    .input(z.object({ repoId: z.string() }))
    .query(async ({ input, ctx }) => {
      return ctx.db.file.findMany({
        where: { repoId: input.repoId },
      })
    }),
})