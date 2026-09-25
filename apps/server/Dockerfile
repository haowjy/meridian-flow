# Build from the repository root: docker build -f apps/server/Dockerfile .
FROM node:24.17.0-bookworm-slim AS build
ENV COREPACK_HOME=/corepack
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.34.3 --activate
WORKDIR /workspace
COPY . .
RUN git init -q .
RUN pnpm install --filter @meridian/server... --frozen-lockfile
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
# RELEASE_BUNDLE_COPY_POINT: integration adds packages/database/dist/release/ here.
ARG MERIDIAN_RELEASE_SHA=unknown
ENV MERIDIAN_RELEASE_SHA=${MERIDIAN_RELEASE_SHA}
USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
