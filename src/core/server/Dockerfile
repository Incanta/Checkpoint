# ============================================================
# Dockerfile for @checkpointvcs/server (Express core server)
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
# requires a live database.
RUN YARN_ENABLE_SCRIPTS=0 yarn install --immutable || YARN_ENABLE_SCRIPTS=0 yarn install

# --------------- builder ---------------
FROM base AS builder
WORKDIR /app

COPY --from=deps /app ./

# Copy source for common + server (both tsconfigs extend ../tsconfig.json)
COPY src/core/common src/core/common
COPY src/core/server/src src/core/server/src
COPY src/core/server/tsconfig.json src/core/server/tsconfig.json
COPY src/core/tsconfig.json src/core/tsconfig.json

# Build common first, then server
RUN cd src/core/common && npx tsgo -p .
RUN cd src/core/server && npx tsgo -p .

# --------------- runner ---------------
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Install runtime native dependencies for longtail addon
RUN apk add --no-cache libssl3 libpsl

RUN addgroup --system --gid 1001 appgroup && \
    adduser --system --uid 1001 appuser

# Copy built output
COPY --from=builder /app/src/core/common/lib ./src/core/common/lib
COPY --from=builder /app/src/core/common/package.json ./src/core/common/package.json
COPY --from=builder /app/src/core/server/lib ./src/core/server/lib
COPY --from=builder /app/src/core/server/package.json ./src/core/server/package.json

# Copy node_modules (workspace-resolved)
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/src/core/common/node_modules ./src/core/common/node_modules
COPY --from=deps /app/src/core/server/node_modules ./src/core/server/node_modules

# Copy config files for @incanta/config
COPY src/core/server/config ./src/core/server/config

# Create data directory
RUN mkdir -p /app/data && chown appuser:appgroup /app/data

USER appuser

EXPOSE 3000

WORKDIR /app/src/core/server

CMD ["node", "lib/index.js"]
