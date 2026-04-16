# ============================================================
# Dockerfile for @checkpointvcs/license-manager
# Build context: repository root
# ============================================================

# --------------- base ---------------
FROM node:24-slim AS base
RUN corepack enable && corepack prepare yarn@4.13.0

# --------------- builder ---------------
FROM base AS builder
WORKDIR /app

COPY . .

RUN YARN_ENABLE_SCRIPTS=0 yarn install --immutable

# Generate Prisma client (the postinstall is skipped above)
RUN cd src/app && npx prisma generate

RUN cd src/core/license-manager && yarn build

# --------------- runner ---------------
FROM node:24-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 appgroup && \
    useradd --system --uid 1001 --gid appgroup appuser

# Copy built output
COPY --from=builder /app/src/core/license-manager/lib ./src/core/license-manager/lib
COPY --from=builder /app/src/core/license-manager/package.json ./src/core/license-manager/package.json

# Copy node_modules (includes @prisma/client with generated types)
COPY --from=builder /app/node_modules ./node_modules

# Copy config files for @incanta/config
COPY src/core/license-manager/config ./src/core/license-manager/config

# Create config directory for local/production overrides
RUN mkdir -p /app/config && chown appuser:appgroup /app/config
RUN ln -s /app/config /app/src/core/license-manager/config/local

ENV NODE_CONFIG_DIR=/app/src/core/license-manager/config
ENV NODE_CONFIG_ENV=local

USER appuser

EXPOSE 13002

WORKDIR /app/src/core/license-manager

CMD ["node", "lib/index.js"]
