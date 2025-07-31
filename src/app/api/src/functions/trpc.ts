import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { appRouter } from '../routers'
import { Context } from '../lib/trpc'
import { db } from '../lib/db'
import { getCurrentUser, authDecoder } from '../lib/auth'

async function createContext(request: Request): Promise<Context> {
  let currentUser = null
  
  try {
    // Try to extract auth token from headers
    const authHeader = request.headers.get('authorization')
    if (authHeader) {
      const [type, token] = authHeader.split(' ')
      if (type === 'Bearer' && token) {
        const decoded = await authDecoder(token, 'api-token')
        if (decoded) {
          currentUser = await getCurrentUser(decoded, { schema: '', token, type: 'api-token' })
        }
      }
    }
  } catch (error) {
    console.warn('Auth error:', error)
    // Continue with null user
  }
  
  return {
    currentUser,
    db,
  }
}

export const handler = async (request: Request): Promise<Response> => {
  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req: request,
    router: appRouter,
    createContext: () => createContext(request),
  })
}