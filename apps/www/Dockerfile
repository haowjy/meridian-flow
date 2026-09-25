# Build from the repository root: docker build -f apps/www/Dockerfile .
FROM node:24.17.0-bookworm-slim AS build
ENV COREPACK_HOME=/corepack
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.34.3 --activate
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc lefthook.yml ./
COPY patches/ ./patches/
RUN pnpm fetch
COPY . .
# git init lets the root prepare hook install lefthook; fetch+offline install
# means workspace additions need no hand-maintained manifest list.
RUN git init -q . && pnpm install --offline --frozen-lockfile --filter @meridian/www... \
 && pnpm --filter @meridian/www build

FROM node:24.17.0-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=::
WORKDIR /app
COPY --from=build --chown=node:node /workspace/apps/www/.output ./.output
ARG MERIDIAN_VERSION=unknown
ARG MERIDIAN_RELEASE_SHA=unknown
ENV MERIDIAN_VERSION=${MERIDIAN_VERSION} MERIDIAN_RELEASE_SHA=${MERIDIAN_RELEASE_SHA}
LABEL org.opencontainers.image.source="https://github.com/haowjy/meridian-flow" \
      org.opencontainers.image.version=${MERIDIAN_VERSION} \
      org.opencontainers.image.revision=${MERIDIAN_RELEASE_SHA}
USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
