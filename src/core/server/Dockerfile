# ============================================================
# Dockerfile for @checkpointvcs/server (Express core server)
# Build context: repository root
# ============================================================

# --------------- base ---------------
FROM node:24-slim AS base
RUN corepack enable && corepack prepare yarn@4.13.0

# --------------- builder ---------------
FROM base AS builder
WORKDIR /app

# Install build tools needed for native addon compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    python3 \
    libssl-dev \
    git \
  && rm -rf /var/lib/apt/lists/*

COPY . .

RUN yarn install --immutable
RUN yarn build

RUN cd src/core/server && yarn build

# Verify the longtail addon prebuilds exist
RUN ls -la node_modules/@checkpointvcs/longtail-addon/prebuilds/linux-x64/longtail_addon.node

# --------------- runner ---------------
FROM node:24-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

# Install runtime native dependencies for longtail addon
RUN apt-get update && apt-get install -y --no-install-recommends \
    libssl3 \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 appgroup && \
    useradd --system --uid 1001 --gid appgroup appuser

# Copy built output
COPY --from=builder /app/src/core/common/lib ./src/core/common/lib
COPY --from=builder /app/src/core/common/package.json ./src/core/common/package.json
COPY --from=builder /app/src/core/server/lib ./src/core/server/lib
COPY --from=builder /app/src/core/server/package.json ./src/core/server/package.json

# Copy node_modules (workspace-resolved)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src/core/common/node_modules* ./src/core/common/node_modules
COPY --from=builder /app/src/core/server/node_modules* ./src/core/server/node_modules

# Copy config files for @incanta/config
COPY src/core/server/config ./src/core/server/config

# Create data directory
RUN mkdir -p /app/data && chown appuser:appgroup /app/data
RUN ln -s /app/data /app/src/core/server/data

# Create config directory
RUN mkdir -p /app/config && chown appuser:appgroup /app/config
RUN ln -s /app/config /app/src/core/server/config/local

ENV NODE_CONFIG_DIR=/app/src/core/server/config
ENV NODE_CONFIG_ENV=local

USER appuser

EXPOSE 3000

WORKDIR /app/src/core/server

CMD ["node", "lib/index.js"]
