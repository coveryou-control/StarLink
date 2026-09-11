# =====================================================================================
# StarLink — one image, four processes.
#
# ## Why a single image rather than four
#
# The four applications share a pnpm workspace and eleven internal packages. Four images
# would each rebuild the same workspace and could drift to different commits of
# `@starlink/conversation-domain` — which is the one package where two versions running at
# once is a security question rather than a bug, because it is where `decide()` lives.
#
# One image, selected by command, cannot drift. `docker compose` picks the process:
#
#   node apps/api/dist/main.js               the HTTP API and the sweeps
#   node apps/realtime-gateway/dist/main.js  the socket gateway and the outbox relay
#   pnpm --filter @starlink/employee-web start
#   pnpm --filter @starlink/customer-web start
#
# ## Why the build is staged
#
# The final stage carries no compiler, no dev dependency and no source. It runs as a
# non-root user, because a container that can write its own application directory is one
# exploit away from persisting a change to it.
# =====================================================================================

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# ---- dependencies -------------------------------------------------------------------
# Manifests first: this layer is cached until a package.json or the lockfile changes,
# which is what keeps an ordinary code change from re-resolving the whole workspace.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json                    apps/api/
COPY apps/realtime-gateway/package.json       apps/realtime-gateway/
COPY apps/employee-web/package.json           apps/employee-web/
COPY apps/customer-web/package.json           apps/customer-web/
COPY packages/                                packages/
COPY adapters/                                adapters/
COPY infrastructure/                          infrastructure/
RUN pnpm install --frozen-lockfile

# ---- build --------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm build

# ---- runtime ------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

# `--prod` drops every dev dependency: no TypeScript, no vitest, no playwright in a
# running container.
COPY --from=build /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/package.json ./
COPY --from=build /app/apps           ./apps
COPY --from=build /app/packages       ./packages
COPY --from=build /app/adapters       ./adapters
COPY --from=build /app/infrastructure ./infrastructure
RUN pnpm install --frozen-lockfile --prod

# One writable directory, OUTSIDE the application tree.
#
# The local object driver mkdirs its root at construction — `LocalObjectStorage` holds
# `new DiskObjects()` as a field initializer — and that root defaults to
# `process.cwd()/.starlink-objects`, which is `/app`. Every layer above is built as root,
# so `USER node` then met a directory it could not write and the container died at boot
# with EACCES. `SL_ADAPTER_OBJECT_STORAGE` defaults to `local`, so this was the DEFAULT
# command of the only release artefact, and nothing caught it because no gate builds this
# image.
#
# `chown -R /app` would have fixed it and broken the reason `USER node` is here at all —
# see the header: "a container that can write its own application directory is one
# exploit away from persisting a change to it". So the writable path is a single
# directory elsewhere, owned by `node`, and the application tree stays read-only to the
# process.
#
# This makes the image BOOT. It does not make the local driver deployable: `loadConfig`
# still refuses it on staging and production, where `remote` and a real bucket are
# required. The contents here are ephemeral and vanish with the container.
RUN mkdir -p /var/lib/starlink/objects && chown -R node:node /var/lib/starlink
ENV SL_STORAGE_LOCAL_DIR=/var/lib/starlink/objects

# Non-root. `node` exists in the base image already.
USER node

# Every process reads its port from configuration; nothing is published here, because a
# hardcoded EXPOSE would disagree with SL_API_PORT the first time somebody changed it.
CMD ["node", "apps/api/dist/main.js"]
