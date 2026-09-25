# Build from the repository root: docker build -f apps/app/Dockerfile .
FROM node:24.17.0-bookworm-slim AS build
ENV COREPACK_HOME=/corepack
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.34.3 --activate
WORKDIR /workspace
COPY . .
RUN git init -q .
RUN pnpm install --filter @meridian/app... --frozen-lockfile
RUN pnpm --filter @meridian/app build

FROM node:24.17.0-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=::
WORKDIR /app
COPY --from=build --chown=node:node /workspace/apps/app/.output ./.output
COPY --from=build --chown=node:node /workspace/apps/app/scripts/validate-start-env.mjs ./scripts/validate-start-env.mjs
ARG MERIDIAN_RELEASE_SHA=unknown
ENV MERIDIAN_RELEASE_SHA=${MERIDIAN_RELEASE_SHA}
USER node
EXPOSE 3000
CMD ["sh", "-c", "node scripts/validate-start-env.mjs && exec node .output/server/index.mjs"]
