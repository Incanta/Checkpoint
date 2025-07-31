import { router } from '../lib/trpc'
import { usersRouter } from './users'
import { orgsRouter } from './orgs'
import { reposRouter } from './repos'
import { changelistsRouter } from './changelists'
import { filesRouter } from './files'
import { branchesRouter } from './branches'
import { fileCheckoutsRouter } from './fileCheckouts'
import { apiTokensRouter } from './apiTokens'
import { storageRouter } from './storage'
import { workspacesRouter } from './workspaces'

export const appRouter = router({
  users: usersRouter,
  orgs: orgsRouter,
  repos: reposRouter,
  changelists: changelistsRouter,
  files: filesRouter,
  branches: branchesRouter,
  fileCheckouts: fileCheckoutsRouter,
  apiTokens: apiTokensRouter,
  storage: storageRouter,
  workspaces: workspacesRouter,
})

export type AppRouter = typeof appRouter