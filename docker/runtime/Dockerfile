# ============================================================
# Checkpoint runtime image
#
# Carries no application code. It resolves, verifies and executes a signed
# deployment bundle at boot (see bootstrap.js). One image serves both the app
# and the core server; CHECKPOINT_COMPONENT picks which.
#
# Rebuilt only when this directory, the Node major, or the base image changes,
# NOT once per Checkpoint release. Its tag is the ABI it provides, because the
# bundles carry native code (the longtail addon, Prisma query engines) built
# against exactly this Node ABI, glibc and OpenSSL:
#
#   ghcr.io/incanta/checkpoint-runtime:node24
#
# Build context: repository root
#   docker build -f docker/runtime/Dockerfile -t checkpoint-runtime:node24 .
# ============================================================

# Pinned to the Debian codename, not the floating `node:24-slim`. That tag
# follows whatever docker-node currently calls the Debian default, which is
# bookworm today and will move to trixie; the move would take glibc with it and
# quietly falsify the ABI string below without changing a line of this file.
# Changing this line is an ABI change: bump CHECKPOINT_RUNTIME_ABI and
# RUNTIME_ABI in scripts/bundle/build-bundle.js with it.
FROM node:24-bookworm-slim

# libssl3   the longtail addon and Prisma both link against it
# zstd      bundle archives are tar.zst
# ca-certificates  TLS to github.com for the manifest and assets
RUN apt-get update && apt-get install -y --no-install-recommends \
      libssl3 \
      ca-certificates \
      zstd \
  && rm -rf /var/lib/apt/lists/*

# Must match RUNTIME_ABI in scripts/bundle/build-bundle.js. bootstrap.js refuses
# a bundle whose manifest declares a different ABI, so this string is the
# compatibility contract between image and bundle.
ENV CHECKPOINT_RUNTIME_ABI=node24-debian12-openssl3

ENV CHECKPOINT_STATE_DIR=/var/lib/checkpoint \
    CHECKPOINT_BUNDLE_CHANNEL=release \
    CHECKPOINT_DB_PROVIDER=sqlite \
    NODE_ENV=production

WORKDIR /app

COPY docker/runtime/bootstrap.js docker/runtime/entrypoint.sh ./runtime/
COPY scripts/bundle/signing.js ./runtime/signing.js

RUN chmod +x ./runtime/entrypoint.sh

# The bundle volume holds downloaded bundles plus the state that says which one
# should be running. It must be a volume: it is what survives a restart, and
# what makes "install this update" stick.
RUN groupadd --system --gid 1001 checkpoint && \
    useradd --system --uid 1001 --gid checkpoint --home /app checkpoint && \
    mkdir -p /var/lib/checkpoint /app/config /app/data && \
    chown -R checkpoint:checkpoint /var/lib/checkpoint /app

VOLUME ["/var/lib/checkpoint"]

USER checkpoint

# 13000 app, 13001 core server. Only one is used per container.
EXPOSE 13000 13001

ENTRYPOINT ["/app/runtime/entrypoint.sh"]
