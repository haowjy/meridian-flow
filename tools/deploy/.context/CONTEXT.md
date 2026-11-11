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

## Putting the landing page live

`MERIDIAN_WWW_ORIGIN` on `@meridian/app` is the switch: unset, signed-out `/` goes to sign-in and log out to `/login`, so the app can deploy before the page. Why signed-out visitors land on the page is in the KB's [Public Site](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/product/public-site.md).

1. Register the sign-out redirects in WorkOS (Redirects → Sign-out redirects): the production and staging landing URLs and `https://web.meridian.localhost`, plus a worktree's own dev prefix when that stack needs real log out. Try log out once afterwards: what WorkOS does with an unregistered URL is unconfirmed.
2. Deploy `@meridian/www`; on staging set `MERIDIAN_APP_ORIGIN` to the staging app.
3. Only then set `MERIDIAN_WWW_ORIGIN`. Open the www address first and check it serves the page: while the apex and www domains still redirect to the app, setting it makes signed-out `/` a redirect loop.

To roll the page back, unset `MERIDIAN_WWW_ORIGIN` first.
