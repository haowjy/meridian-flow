# Local production-shaped stack

This Compose stack builds the production Dockerfiles and sends public traffic
through Caddy. Its WorkOS credentials and model-provider key are structurally
valid fakes accepted by the live-configuration guards; never use them against a
real account or provider. The AuthKit callback and ingress use
`http://meridian.localtest.me:18080`, which resolves to loopback without an
`/etc/hosts` entry. Postgres is exposed on host port `55432`, and the
uploads-only RustFS endpoint is exposed on `19001` (`uploads.localtest.me`).

Set release identity from the checkout before building. The compose defaults
  remain usable for a quick local run, but the current commit SHA lets the backup
reference and image labels prove the exact release:

```sh
export MERIDIAN_VERSION=0.0.0-local
export MERIDIAN_RELEASE_SHA="$(git rev-parse HEAD)"
docker compose -f tools/deploy/local/compose.yml up --build -d
```

Compose runs one ordered release chain before the server starts:

1. `backup` runs `pg_dump -Fc` against this stack's Postgres and verifies the
   named-volume dump with both a non-empty check and `pg_restore --list`.
2. `release` runs `/app/release/release.mjs` from the server image. Its
   `MERIDIAN_BACKUP_REF` names the exact release SHA; it applies migrations and
   functions atomically.
3. `server` starts only after `release` exits successfully. App and www become
   healthy, and ingress serves them on `http://localhost:18080`.

Inspect evidence and endpoints:

```sh
docker compose -f tools/deploy/local/compose.yml ps -a
# backup/release logs include dump size, accepted backup ref and migration count
docker compose -f tools/deploy/local/compose.yml logs backup release
curl -i http://localhost:18080/healthz
curl -i http://localhost:18080/readyz
curl -i http://localhost:18080/login
```

The backup volume can restore the predeploy database into an empty target
Postgres using a local `postgres:16` client:

```sh
RESTORE_DATABASE_URL=postgres://postgres:postgres@postgres:5432/restoredb \
  docker compose -f tools/deploy/local/compose.yml run --rm -e RESTORE_DATABASE_URL \
  --entrypoint sh backup -ec \
  'pg_restore --clean --if-exists --no-owner --dbname="$RESTORE_DATABASE_URL" \
   "/backups/predeploy-${MERIDIAN_RELEASE_SHA}.dump"'
```

The target database must already exist and `RESTORE_DATABASE_URL` must point to
it. Remove the stack, database and backup dump when finished:

```sh
docker compose -f tools/deploy/local/compose.yml down -v
```

Caddy forwards `X-Forwarded-Proto: https`, matching the TLS-terminating
production edge. `/ws/yjs` and `/api/threads/ws` require WebSocket upgrade
requests, not ordinary HTTP requests.
