# tools/deploy — staging promotion pipeline

Scaffold for promoting integration branches to a staging environment. The flow is intentionally staging-first: prove build, migration, deploy, and smoke behavior on one tier before mirroring it to production.

## What runs

`.github/workflows/deploy-staging.yml` fires on push to `staging` and manual `workflow_dispatch`. It gates on CI, then runs:

| Step | Status | Becomes real when… |
|---|---|---|
| Build release artifacts | real | always |
| `run-migrations.sh` | real when database secret exists | `STAGING_DATABASE_URL` is configured |
| `deploy-staging.sh` | stub | the publish command is wired at the swap-in block |
| `smoke-check.sh` | stub unless URL exists | `STAGING_URL` is configured |

Stubs are loud on purpose: a green deployment run must not imply that real infrastructure was updated when the target is still unwired.

## Runtime assumptions

- Apps are TypeScript deployables: `@meridian/app`, `@meridian/server`, and `@meridian/www`.
- Migrations run through the Drizzle-backed `@meridian/database` package (provider-agnostic Postgres).
- Provider credentials and staging URLs are configuration, not source-code constants.
