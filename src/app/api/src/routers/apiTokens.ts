import { z } from 'zod'
import { router, protectedProcedure } from '../lib/trpc'

export const apiTokensRouter = router({
  list: protectedProcedure
    .query(async ({ ctx }) => {
      return ctx.db.apiToken.findMany({
        where: { userId: ctx.currentUser.id },
      })
    }),

  create: protectedProcedure
    .input(z.object({
      name: z.string(),
      expiresAt: z.date().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      // Generate a secure token
      const token = `ckpt_${Math.random().toString(36).substr(2, 9)}_${Math.random().toString(36).substr(2, 9)}`
      
      return ctx.db.apiToken.create({
        data: {
          ...input,
          token,
          userId: ctx.currentUser.id,
        },
      })
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      return ctx.db.apiToken.delete({
        where: { 
          id: input.id,
          userId: ctx.currentUser.id, // Ensure user can only delete their own tokens
        },
      })
    }),
})