import { initTRPC } from '@trpc/server'
import { z } from 'zod'
import { db } from './db'
import { RedwoodUser } from './auth'

export interface Context {
  currentUser: RedwoodUser | null
  db: typeof db
}

const t = initTRPC.context<Context>().create()

export const router = t.router
export const publicProcedure = t.procedure
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.currentUser) {
    throw new Error('Not authenticated')
  }
  return next({
    ctx: {
      ...ctx,
      currentUser: ctx.currentUser,
    },
  })
})