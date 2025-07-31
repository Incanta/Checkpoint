import { z } from 'zod'
import { router, publicProcedure, protectedProcedure } from '../lib/trpc'

const createUserInput = z.object({
  name: z.string(),
  username: z.string(),
  email: z.string().email(),
  checkpointAdmin: z.boolean().optional().default(false),
})

const updateUserInput = z.object({
  name: z.string().optional(),
  username: z.string().optional(),
  email: z.string().email().optional(),
  checkpointAdmin: z.boolean().optional(),
})

export const usersRouter = router({
  me: protectedProcedure
    .query(async ({ ctx }) => {
      return ctx.db.user.findUnique({
        where: { id: ctx.currentUser.id },
      })
    }),

  list: publicProcedure
    .query(async ({ ctx }) => {
      return ctx.db.user.findMany()
    }),

  byId: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      return ctx.db.user.findUnique({
        where: { id: input.id },
      })
    }),

  create: publicProcedure
    .input(createUserInput)
    .mutation(async ({ input, ctx }) => {
      if (process.env.NODE_ENV !== "test") {
        throw new Error("createUser is only available in testing environments")
      }

      return ctx.db.user.create({
        data: input,
      })
    }),

  update: protectedProcedure
    .input(z.object({
      id: z.string(),
      data: updateUserInput,
    }))
    .mutation(async ({ input, ctx }) => {
      return ctx.db.user.update({
        data: input.data,
        where: { id: input.id },
      })
    }),

  // Relation queries
  orgs: protectedProcedure
    .input(z.object({ userId: z.string() }))
    .query(async ({ input, ctx }) => {
      return ctx.db.user.findUnique({ 
        where: { id: input.userId } 
      }).orgs()
    }),

  specificRepoRoles: protectedProcedure
    .input(z.object({ userId: z.string() }))
    .query(async ({ input, ctx }) => {
      return ctx.db.user.findUnique({ 
        where: { id: input.userId } 
      }).specificRepoRoles()
    }),

  fileCheckouts: protectedProcedure
    .input(z.object({ userId: z.string() }))
    .query(async ({ input, ctx }) => {
      return ctx.db.user.findUnique({ 
        where: { id: input.userId } 
      }).fileCheckouts()
    }),

  changelists: protectedProcedure
    .input(z.object({ userId: z.string() }))
    .query(async ({ input, ctx }) => {
      return ctx.db.user.findUnique({ 
        where: { id: input.userId } 
      }).changelists()
    }),
})