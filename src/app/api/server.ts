import { serve } from '@redwoodjs/api-server'

const port = process.env.PORT ? parseInt(process.env.PORT) : 8911

console.log(`Starting tRPC server on port ${port}...`)

serve({
  port,
  host: '0.0.0.0',
})

console.log(`🚀 tRPC server ready at http://localhost:${port}`)