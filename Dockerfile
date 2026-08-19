# syntax=docker/dockerfile:1

# ────────────────────────────────────────────────────────────────
# Stage 1: dependencies (pnpm 11 via corepack, full tree)
# ────────────────────────────────────────────────────────────────
FROM node:24-slim AS deps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ────────────────────────────────────────────────────────────────
# Stage 2: build (tsc → dist/)
# ────────────────────────────────────────────────────────────────
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# pnpm-workspace.yaml + lockfile are needed here so `pnpm build`'s
# verifyDepsBeforeRun re-checks supply-chain policy WITH the
# minimumReleaseAgeExclude list (otherwise ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# ────────────────────────────────────────────────────────────────
# Stage 3: runtime — non-root, read-only root FS, no published ports
# (security.md §6/§9: token via env only; manifest baked in image)
# ────────────────────────────────────────────────────────────────
FROM node:24-slim AS runtime

# Non-root user (node:24-slim ships it).
USER node
WORKDIR /app

# Compiled JS + production dependencies only.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

# Authoring config (JSON) + committed manifest (bindings). Compose mounts
# /app/config and /app/state as writable volumes for capture/create. Without
# those mounts the image remains safely read-only and create aborts before any
# POST because pending-create state cannot be persisted.
COPY --chown=node:node config ./config
COPY --chown=node:node .chrysalis ./state

ENV CHRYSALIS_STATE_DIR=/app/state
ENV NODE_ENV=production

# One-shot CLI: subcommands passed as args (see docker-compose.yml).
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["help"]
