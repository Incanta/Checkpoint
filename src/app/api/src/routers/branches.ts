import { z } from 'zod'
import { router, protectedProcedure } from '../lib/trpc'

export const branchesRouter = router({
  list: protectedProcedure
    .input(z.object({ repoId: z.string() }))
    .query(async ({ input, ctx }) => {
      return ctx.db.branch.findMany({
        where: { repoId: input.repoId },
      })
    }),

  byId: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      return ctx.db.branch.findUnique({
        where: { id: input.id },
      })
    }),

  create: protectedProcedure
    .input(z.object({
      repoId: z.string(),
      name: z.string(),
      headNumber: z.number(),
      isDefault: z.boolean().optional().default(false),
    }))
    .mutation(async ({ input, ctx }) => {
      return ctx.db.branch.create({
        data: input,
      })
    }),
})