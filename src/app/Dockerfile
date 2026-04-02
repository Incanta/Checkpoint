# ============================================================
# Dockerfile for @checkpointvcs/app (Next.js standalone)
# Build context: repository root
# ============================================================

# --------------- base ---------------
FROM node:24-alpine AS base
RUN corepack enable && corepack prepare yarn@4.13.0

# --------------- deps ---------------
FROM base AS deps
WORKDIR /app

# Copy workspace structure for dependency resolution
COPY package.json yarn.lock .yarnrc.yml ./
COPY src/app/package.json src/app/package.json
COPY src/core/package.json src/core/package.json
COPY src/core/common/package.json src/core/common/package.json
COPY src/core/server/package.json src/core/server/package.json
COPY src/core/daemon/package.json src/core/daemon/package.json
COPY src/clients/desktop/package.json src/clients/desktop/package.json

# Skip lifecycle scripts — root postinstall runs db:migrate:dev which
# requires a live database.  Prisma generate runs in the builder stage.
RUN YARN_ENABLE_SCRIPTS=0 yarn install --immutable || YARN_ENABLE_SCRIPTS=0 yarn install

# --------------- builder ---------------
FROM base AS builder
WORKDIR /app

COPY --from=deps /app ./

# Copy full source (includes prisma schema, config, scripts)
COPY src/app src/app
COPY src/core/common src/core/common

# Generate Prisma client
RUN cd src/app && npx prisma generate

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

# Create data directory for SQLite
RUN mkdir -p /app/data && chown nextjs:nodejs /app/data

USER nextjs

EXPOSE 3000

# The standalone server.js is at the workspace package location
CMD ["node", "src/app/server.js"]
