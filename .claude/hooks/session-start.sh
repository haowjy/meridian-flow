#!/bin/bash
# Cloud (Claude Code on the web) session bootstrap: deps, a local Postgres on
# :54422, the dev database, the Portless HTTPS proxy, and `pnpm dev --no-tailscale`
# so `./mf` can drive the running app. Idempotent; local machines skip it.
set -uo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT" || exit 0
mkdir -p logs
LOG="$ROOT/logs/session-start.log"
: >"$LOG"

# Hook stdout becomes session context, so steps log to the file and only the
# summary lines below are printed.
say() { echo "session-start: $*"; }
run() { "$@" >>"$LOG" 2>&1; }

PG_BIN=/usr/lib/postgresql/16/bin
PG_DIR=/var/lib/postgresql/meridian-dev
PG_PORT=54422
DB_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/meridian"

# 1. Dependencies (pnpm install reuses the cached store and node_modules).
if ! run pnpm install --prefer-offline; then
  say "pnpm install failed; see logs/session-start.log"
  exit 0
fi

# 2. Local env. Secrets (WORKOS_*, provider keys) come from the environment
#    settings, never this file.
if [ ! -f .env ]; then
  cat >.env <<EOF
DATABASE_URL=${DB_URL}
PGPASSWORD=postgres
WORKOS_REDIRECT_URI=https://app.meridian.localhost/api/auth/callback
EOF
fi

# 3. Postgres 16 from the image's packages. The Docker path (`pnpm dev:infra`)
#    needs a daemon and Docker Hub pulls, which cloud containers rate-limit.
if [ ! -x "$PG_BIN/pg_ctl" ]; then
  say "postgres 16 binaries not found at $PG_BIN; skipping the dev stack"
  exit 0
fi
if [ ! -f "$PG_DIR/data/PG_VERSION" ]; then
  run su postgres -c "mkdir -p $PG_DIR && echo postgres > $PG_DIR/pw && $PG_BIN/initdb -D $PG_DIR/data -U postgres --pwfile=$PG_DIR/pw -A scram-sha-256"
fi
if ! "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PG_PORT" -q; then
  run su postgres -c "$PG_BIN/pg_ctl -D $PG_DIR/data -o '-p $PG_PORT -k /tmp' -l $PG_DIR/log -w start"
fi
if ! "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PG_PORT" -q; then
  say "postgres did not start; see $PG_DIR/log"
  exit 0
fi

# 4. Database, extensions, migrations, SQL functions. The container's `meridian`
#    database is disposable, so this is the one place the main-database guard is
#    deliberately waived; local checkouts never run this hook.
set -a
# shellcheck disable=SC1091
. ./.env
set +a
if ! run pnpm dev:db:ensure \
  || ! run pnpm exec tsx -e '
      const { DEV_DATABASES } = require("./tools/dev/lib/dev-env.ts");
      const { ensureExtensionsForUrl } = require("./tools/dev/lib/dev-db.ts");
      Promise.all(DEV_DATABASES.filter((db) => db.extensions?.length && process.env[db.envVar])
        .map((db) => ensureExtensionsForUrl(process.env[db.envVar], db.extensions)));' \
  || ! run pnpm db:migrate --allow-main-database \
  || ! run pnpm db:apply-functions; then
  say "database prepare failed; see logs/session-start.log"
  exit 0
fi

# 5. Portless HTTPS proxy on :443 (root, so no sudo prompt).
if ! curl -sk -o /dev/null --max-time 3 https://127.0.0.1:443/; then
  # No proxy means a restarted container: every saved route is stale, and its
  # recorded PID can belong to an unrelated new process, which blocks re-registering.
  rm -f "$HOME/.portless/routes.json"
  run node_modules/.bin/portless proxy start --https
fi

# 6. The app stack. Dev login needs WorkOS Staging keys plus a password user.
if [ -z "${WORKOS_API_KEY:-}" ] || [ -z "${WORKOS_DEV_LOGIN_EMAIL:-}" ]; then
  say "database ready; WORKOS_* not set, so the app stack was not started"
  exit 0
fi
if run pnpm dev --no-tailscale; then
  say "dev stack up (https://app.meridian.localhost, https://server.meridian.localhost); ./mf is ready"
else
  say "pnpm dev failed; see logs/session-start.log and logs/portless.log"
fi
exit 0
