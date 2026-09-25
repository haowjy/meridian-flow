# Build from the repository root: docker build -f apps/app/Dockerfile .
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
RUN git init -q . && pnpm install --filter @meridian/app... --frozen-lockfile
COPY . .
RUN pnpm --filter @meridian/app build

FROM node:24.17.0-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=::
WORKDIR /app
COPY --from=build --chown=node:node /workspace/apps/app/.output ./.output
COPY --from=build --chown=node:node /workspace/apps/app/scripts/validate-start-env.mjs ./scripts/validate-start-env.mjs
ARG MERIDIAN_VERSION=unknown
ARG MERIDIAN_RELEASE_SHA=unknown
ENV MERIDIAN_VERSION=${MERIDIAN_VERSION} MERIDIAN_RELEASE_SHA=${MERIDIAN_RELEASE_SHA}
LABEL org.opencontainers.image.source="https://github.com/haowjy/meridian-flow" \
      org.opencontainers.image.version=${MERIDIAN_VERSION} \
      org.opencontainers.image.revision=${MERIDIAN_RELEASE_SHA}
USER node
EXPOSE 3000
CMD ["sh", "-c", "node scripts/validate-start-env.mjs && exec node .output/server/index.mjs"]
