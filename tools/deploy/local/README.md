# Local production-shaped stack

This Compose stack builds the production Dockerfiles and routes one public
origin through Caddy. Its WorkOS values are structurally valid but fake; never
use them against a real account. Postgres is exposed on host port `55432`, and
RustFS on `19001`, so local migrations and host-side S3 clients can reach the
services before the release lane adds its backup+migrate one-shot service.
RustFS provides local S3-compatible storage: `uploads` is the server's object
bucket and `backups` is reserved for the release bundle. The one-shot AWS CLI
service creates both buckets over the S3 API.

Use the direct Drizzle CLI for this isolated Compose database. The root
`pnpm db:migrate` wrapper intentionally rewrites registered database URLs to a
per-worktree development database.

```sh
docker compose -f tools/deploy/local/compose.yml up -d --wait postgres object-store object-store-buckets
DATABASE_URL=postgres://postgres:postgres@localhost:55432/meridian pnpm --filter @meridian/database exec drizzle-kit migrate
DATABASE_URL=postgres://postgres:postgres@localhost:55432/meridian pnpm db:apply-functions
docker compose -f tools/deploy/local/compose.yml up -d --build --wait
curl -i http://localhost:18080/healthz
curl -i http://localhost:18080/readyz
curl -i http://localhost:18080/
curl -i http://localhost:18080/login
docker compose -f tools/deploy/local/compose.yml down -v
```

Public requests use `http://localhost:18080`; host S3 access uses
`http://localhost:19001`. Caddy explicitly forwards
`X-Forwarded-Proto: https`, matching the TLS-terminating production edge.
`/ws/yjs` and `/api/threads/ws` require WebSocket upgrade requests, not
ordinary HTTP requests.
