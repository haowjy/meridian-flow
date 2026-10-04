# Deployment contract

1. Merge to `main`; release-on-merge writes one release commit and `vX.Y.Z` tag for the uncovered merge batch.
2. CI verifies that release commit; staging runs only after its successful CI.
3. Build server, app, www, and ingress once; record their immutable GHCR digests in the release manifest.
4. Take and confirm a Neon snapshot, then deploy the manifest digests to staging.
5. Runtime smoke verifies health, readiness, app identity/callback, and WebSocket behavior; record `deploy/staging`.
6. `deploy/staging` success makes that tagged commit eligible for production.
7. Manually dispatch production with that version; promote the exact manifest digests and smoke them.

## Ingress routes

| Public route | Owner | Private upstream |
|---|---|---|
| `/healthz`, `/readyz`, `/api/*` except app-owned auth routes, `/ws/*` | Server | `server.railway.internal:3000` |
| `/api/auth/callback`, `/api/auth/dev-login`, `/`, `/login`, other app routes | App | `app.railway.internal:3000` |
| `/_ingress/health` | Caddy | Ingress itself |
| Marketing site | WWW | Its own Railway public domain |

Caddy refreshes upstream DNS, retries for 10 seconds, forwards
`X-Forwarded-Proto: https`, and limits request bodies to 10 MB. Server requires
one replica. Use Neon direct TLS URLs (`sslmode=require`, no `-pooler` or
`channel_binding=require`); the server holds a Postgres `LISTEN` connection.

## Release labels

| PR labels | Result |
|---|---|
| `release:skip` | Skip that merge (takes precedence) |
| `release:patch` | Stable patch |
| `release:minor` | Stable minor |
| `release:major` | Stable major |
| `release:rc`, unknown `release:*`, or no release label | Patch RC on latest stable |

Strongest stable bump wins unless RC/unknown selects an RC. Root
`package.json` is the version source; initial version is `0.0.0`. Stable tags
are `vX.Y.Z`; prereleases are `vX.Y.Z-rc.N`. Stable releases roll
`CHANGELOG.md`'s `[Unreleased]` section into the release; RCs leave it intact.

## Environment variables

| Name | Service/scope | Who sets it | Required? |
|---|---|---|---|
| `NODE_ENV`, `APP_ENV`, `HOST`, `PORT`, `API_REPLICA_COUNT` | Runtime services | `configure.sh` | Yes; one server replica |
| `DATABASE_URL` | Server/release; Neon direct TLS URL | Human, Railway secret | Yes |
| `MERIDIAN_BACKENDS`, `OBJECT_STORE_PROVIDER`, `S3_BUCKET`, `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Server | Configure/Railway bucket reference; human for secrets | Yes |
| `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD`, `WORKOS_REDIRECT_URI` | Server and app | Human, Railway | Yes |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY` | Server | Human, Railway secret | At least one |
| `MERIDIAN_API_ORIGIN` | App | `configure.sh` | Yes |
| `WEB_DATABASE_URL` | WWW | Railway reference to server DB | Required for DB-backed WWW routes |
| `APP_UPSTREAM_HOST`, `APP_UPSTREAM_PORT`, `SERVER_UPSTREAM_HOST`, `SERVER_UPSTREAM_PORT` | Ingress | `configure.sh` | Yes |
| `RAILWAY_TOKEN` | GitHub `staging`/`production`; local setup | Human | Yes, each scope |
| `NEON_API_KEY` | GitHub `staging`/`production` secret | Human | Yes, each scope |
| `NEON_PROJECT_ID`, `NEON_BRANCH_ID`, `PUBLIC_URL` | GitHub `staging`/`production` variables | Human | Yes, each scope |
| `RELEASE_TOKEN` | GitHub repository secret | Human; admin PAT or bypass App | Yes |
| `NEON_SNAPSHOT_TTL_DAYS` | GitHub deploy environment | Human; defaults 3 staging/14 production | No |
| `MERIDIAN_VERSION`, `MERIDIAN_RELEASE_SHA` | Image build | Workflow | Yes, baked into images |
| `MERIDIAN_BACKUP_REF` | Server release command | Deploy seam, never hand-set | Yes when migrations are pending |
| `WORKOS_DEV_*`, local object-store settings, `WWW_URL`, provider overrides, timeout/poll controls | Development or optional deploy checks | Developer/operator | No; never use dev auth in production |

Exact provisioning, recovery, migration, and local rehearsal instructions are in
the [runbook](./runbook.md).
