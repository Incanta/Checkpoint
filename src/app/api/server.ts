import express from 'express'
import cors from 'cors'
import { createExpressMiddleware } from '@trpc/server/adapters/express'
import { appRouter } from './src/routers'
import { Context } from './src/lib/trpc'
import { db } from './src/lib/db'
import { getCurrentUser, authDecoder } from './src/lib/auth'
import SuperTokens from 'supertokens-node'
import { config } from './src/lib/supertokens'
import { middleware as supertokensMiddleware, errorHandler } from 'supertokens-node/framework/express'

// Initialize SuperTokens
SuperTokens.init(config)

const port = process.env.PORT ? parseInt(process.env.PORT) : 8911
const app = express()

// CORS configuration
app.use(cors({
  origin: [
    'http://localhost:8910',
    'http://localhost:3000',
    process.env.SUPERTOKENS_WEBSITE_DOMAIN || 'http://localhost:8910'
  ],
  allowedHeaders: ['content-type', ...SuperTokens.getAllCORSHeaders()],
  credentials: true,
}))

// SuperTokens middleware
app.use(supertokensMiddleware())

async function createTRPCContext({ req }: { req: express.Request }): Promise<Context> {
  let currentUser = null
  
  try {
    // Try to extract auth token from headers
    const authHeader = req.headers.authorization
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

// tRPC middleware
app.use('/api/trpc', createExpressMiddleware({
  router: appRouter,
  createContext: createTRPCContext,
}))

// SuperTokens error handler
app.use(errorHandler())

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'tRPC API' })
})

// Start server
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 tRPC server ready at http://localhost:${port}`)
  console.log(`📋 Health check: http://localhost:${port}/health`)
  console.log(`🔗 tRPC endpoint: http://localhost:${port}/api/trpc`)
})