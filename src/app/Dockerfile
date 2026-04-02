# ============================================================
# Dockerfile for @checkpointvcs/app (Next.js standalone)
# Build context: repository root
# ============================================================

# --------------- base ---------------
FROM node:24-alpine AS base
RUN corepack enable && corepack prepare yarn@4.13.0

# --------------- builder ---------------
FROM base AS builder
WORKDIR /app

ARG DB_PROVIDER=sqlite

COPY . .

RUN yarn install --immutable

# Set the Prisma datasource provider and generate client
RUN cd src/app && DB_PROVIDER=${DB_PROVIDER} node scripts/set-db-provider.mjs && npx prisma generate

# Build Next.js in standalone mode
ENV SKIP_ENV_VALIDATION=1
RUN cd src/app && yarn build

# Run obfuscation on the standalone output
RUN cd src/app && node scripts/obfuscate.mjs

# --------------- runner ---------------
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME="0.0.0.0"
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone output
COPY --from=builder /app/src/app/.next/standalone ./
COPY --from=builder /app/src/app/.next/static ./src/app/.next/static
COPY --from=builder /app/src/app/public ./src/app/public

# Copy config files for runtime @incanta/config
COPY --from=builder /app/src/app/config ./src/app/config

# Copy Prisma CLI, schema, migrations for runtime migration
# COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
# COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
# COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/src/app/prisma/schema.prisma ./src/app/prisma/schema.prisma
COPY --from=builder /app/src/app/prisma/datasource.prisma ./src/app/prisma/datasource.prisma
COPY --from=builder /app/src/app/prisma/migrations ./src/app/prisma/migrations
COPY --from=builder /app/src/app/start-docker.sh ./start-docker.sh

# retrieve Prisma version from builder's package.json
COPY --from=builder /app/node_modules/prisma/package.json ./prisma-package.json
RUN PRISMA_VERSION=$(node -p "require('/app/prisma-package.json').version") && \
    echo "Installing Prisma CLI version $PRISMA_VERSION" && \
    npm i -g prisma@$PRISMA_VERSION
RUN rm ./prisma-package.json

# Create data directory for SQLite
RUN mkdir -p /app/data && chown nextjs:nodejs /app/data

# Create config directory
RUN mkdir -p /app/config && chown nextjs:nodejs /app/config
RUN ln -s /app/config /app/src/app/config/local

RUN chmod +x /app/start-docker.sh

ENV NODE_CONFIG_DIR=/app/src/app/config
ENV NODE_CONFIG_ENV=local

USER nextjs

EXPOSE 3000

CMD ["/app/start-docker.sh"]
