FROM oven/bun:slim AS base

RUN apt-get update
RUN apt-get install -y --no-install-recommends \
    ca-certificates \
    libssl3 \
    libssl-dev \
    libpsl-dev
COPY package.json ./
RUN mkdir client
RUN mkdir server
RUN mkdir common
COPY client/package.json client/
COPY server/package.json server/
COPY common/package.json common/
COPY bun.lockb ./

FROM base AS dev

RUN bun install

FROM base AS prod

RUN bun install --production --frozen-lockfile
