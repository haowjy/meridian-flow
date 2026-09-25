# Build from the repository root: docker build -f apps/server/Dockerfile .
FROM node:24.17.0-bookworm-slim AS build
ENV COREPACK_HOME=/corepack
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.34.3 --activate
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc lefthook.yml ./
COPY patches/ ./patches/
COPY apps/app/package.json ./apps/app/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY apps/www/package.json ./apps/www/package.json
COPY packages/agent-edit/package.json ./packages/agent-edit/package.json
COPY packages/agent-edit/demo/playground/package.json ./packages/agent-edit/demo/playground/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/database/package.json ./packages/database/package.json
COPY packages/design-tokens/package.json ./packages/design-tokens/package.json
COPY packages/markup/package.json ./packages/markup/package.json
COPY packages/prosemirror-schema/package.json ./packages/prosemirror-schema/package.json
COPY packages/resource-replica/package.json ./packages/resource-replica/package.json
COPY packages/yjs-inspect/package.json ./packages/yjs-inspect/package.json
RUN git init -q . && pnpm install --filter @meridian/server... --frozen-lockfile
COPY . .
RUN pnpm --filter @meridian/server build

FROM node:24.17.0-bookworm-slim AS runtime-base
ENV NODE_ENV=production HOST=::
WORKDIR /app
# PostgreSQL 17 client can dump and restore PostgreSQL 16 databases.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && . /etc/os-release \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $VERSION_CODENAME-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-17 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /workspace/apps/server/.output ./.output
# Nitro externalizes this virtual asset registry; keep the built-in seed source available at runtime.
COPY --from=build --chown=node:node /workspace/apps/server/server/domains/packages/builtin/launch-agents ./server/domains/packages/builtin/launch-agents
# RELEASE_BUNDLE_COPY_POINT: integration adds COPY --from=build /workspace/packages/database/dist/release/ ./release/ here.
ARG MERIDIAN_VERSION=unknown
ARG MERIDIAN_RELEASE_SHA=unknown
ENV MERIDIAN_VERSION=${MERIDIAN_VERSION} MERIDIAN_RELEASE_SHA=${MERIDIAN_RELEASE_SHA}
LABEL org.opencontainers.image.source="https://github.com/haowjy/meridian-flow" \
      org.opencontainers.image.version=${MERIDIAN_VERSION} \
      org.opencontainers.image.revision=${MERIDIAN_RELEASE_SHA}
USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
