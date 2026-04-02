#!/bin/sh

set -e

cd /app/src/app
echo "Running database migrations..."
node /app/node_modules/@incanta/config/lib/config-env.js prisma migrate deploy
echo "Finished database migrations."

cd /app
node /app/node_modules/@incanta/config/lib/config-env.js node src/app/server.js

echo "Server process exited. Keeping container alive for debugging..."
sleep infinity
