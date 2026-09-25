# Deployment runbook

The [deployment contract](./README.md) defines the release flow and variables. Use this sequence for initial setup, deploys, rollback, and recovery. No step may bypass a failed backup, migration, readiness, or smoke check.

## 1. GitHub controls and release credentials

1. In **Settings → Rules → Rulesets**, confirm `protect` on `main` permits the
   release actor to bypass required PR checks. Create a repository-admin
   fine-grained PAT (Contents read/write, this repo only) or a GitHub App with
   Contents read/write and add it as bypass actor. `GITHUB_TOKEN` cannot
   trigger the downstream CI required after release commit pushes.
2. Apply `docs/deploy/tag-ruleset.json` with an admin `gh` login, then inspect
   the result. It must protect `refs/tags/v*` against deletion and updates:

   ```sh
   gh api --method POST repos/haowjy/meridian-flow/rulesets --input docs/deploy/tag-ruleset.json
   gh api repos/haowjy/meridian-flow/rulesets --jq '.[] | select(.name == "Protect version tags") | {id,name,enforcement,conditions,rules}'
   ```

   **Verify:** the tag ruleset targets `v*`; `protect` allows the configured
   release actor to push the release commit and tag.
3. Create GitHub Actions environments `staging` and `production`. Restrict
   deployment branches/tags to `main` for both; add required reviewers to
   production. Required reviewers are available on GitHub Free for public
   repositories, not private ones ([environment docs](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments#required-reviewers)).
4. Add repository secret `RELEASE_TOKEN`. To avoid shell history:

   ```sh
   read -rsp 'Admin PAT or bypass App token: ' VALUE; echo
   printf %s "$VALUE" | gh secret set RELEASE_TOKEN --repo haowjy/meridian-flow
   unset VALUE
   ```

   In each environment add secret `RAILWAY_TOKEN`, secret `NEON_API_KEY`, and
   variables `NEON_PROJECT_ID`, `NEON_BRANCH_ID`, `PUBLIC_URL`,
   `NEON_SNAPSHOT_TTL_DAYS` (3 staging, 14 production). Use a project-scoped
   Neon Editor API key. See the contract table for full ownership.

   **Verify:** secrets and variables appear only in their intended scopes;
   neither deployment environment accepts branches/tags other than `main`.

## 2. Neon database targets

1. Select the production Neon organization. Query its enabled regions; use
   `aws-us-east-1` only if this response includes it, otherwise use
   `aws-us-east-2`:

   ```sh
   read -rsp 'Neon API key: ' NEON_API_KEY; echo
   curl --fail-with-body -sS -H "Authorization: Bearer $NEON_API_KEY" \
     'https://console.neon.tech/api/v2/regions?org_id=<organization-id>' | jq .
   unset NEON_API_KEY
   ```

2. Create a Launch production project and a separate Launch staging project in
   the chosen region. Set explicit autoscaling bounds, disable scale-to-zero,
   and select a history window matching recovery needs. If using a staging
   branch in production project instead, pin its exact branch ID in staging.
3. In both projects copy the direct PostgreSQL URL. Use the non-`-pooler`
   hostname, `sslmode=require`, and remove `channel_binding=require`. Create a
   project-scoped Editor API key per environment and record project and branch
   IDs in the corresponding GitHub environment.

   **Verify:** direct URL connects; project, branch, region, Postgres version,
   autoscaling, always-on setting, and history window are correct. Rehearse
   snapshot creation and restore against a disposable branch. Deploy accepts
   only successful `scheduling`/`running` then `finished` operations with zero
   failures and confirms the snapshot in the target branch list.

## 3. Railway services and runtime settings

1. Create a new Railway project; do not reuse the v1 project. Create
   `staging` and `production` environments, all in Virginia
   (`us-east4-eqdc4a`). In each, create empty image-source services named
   `server`, `app`, `www`, and `ingress`; do not create Railway Postgres.
2. Add a private object-storage bucket/service named `uploads`. Verify that
   its exposed keys are `BUCKET`, `ENDPOINT`, `PUBLIC_ENDPOINT`, `REGION`,
   `ACCESS_KEY_ID`, and `SECRET_ACCESS_KEY`; otherwise set the server S3 values
   manually. Use private bucket access unless the product URL contract requires
   public access.
3. Install the pinned CLI, link the new project, then configure each
   environment using its matching token:

   ```sh
   pnpm add -g @railway/cli@5.62.1
   railway --version
   railway link
   export RAILWAY_TOKEN='<staging-project-token>'
   bash tools/deploy/railway/configure.sh staging
   unset RAILWAY_TOKEN
   export RAILWAY_TOKEN='<production-project-token>'
   bash tools/deploy/railway/configure.sh production
   unset RAILWAY_TOKEN
   ```

4. In each environment, set secrets with `railway variable set --stdin
   --skip-deploys`: direct Neon `DATABASE_URL` on server; WorkOS API key,
   client ID, and 32+ character cookie password on server and app; one live
   model-provider key on server; and bucket secrets if references were not
   available. Set the exact registered WorkOS `WORKOS_REDIRECT_URI` on server
   and app. Staging may use WorkOS test credentials; production must not.
   Do not set development-login variables.
5. Generate a public domain for `ingress` and optionally attach a custom
   domain. Give `www` its own domain. Set each GitHub `PUBLIC_URL` to the
   HTTPS ingress origin.

   **Verify:** all four services are in Virginia; one replica each; app API
   origin and ingress upstreams point at private service hosts; health checks
   are `/readyz`, `/login`, `/`, and `/_ingress/health`; server pre-deploy is
   `node /app/release/release.mjs`; server draining is 30 seconds and overlap
   is zero. Confirm image-source edits deploy and run the server pre-deploy
   command; confirm GHCR access and disable scale-to-zero. These behaviors are
   first-run checks, not assumptions.

## 4. WorkOS and GHCR

1. In WorkOS, configure staging and production AuthKit environments. Register
   `https://<ingress-host>/api/auth/callback` exactly; set matching credentials
   in Railway. Use a distinct cookie password per environment.
2. Make the four GHCR packages public or configure Railway registry credentials
   in both environments. New packages are private by default.

   **Verify:** WorkOS callback host and Railway variables match each public
   ingress origin; Railway can pull server, app, www, and ingress manifests.

## 5. First deploy and routine promotion

1. Merge a PR to `main` with a release label. `release:skip` opts out;
   unlabeled/RC batches create a patch prerelease. Release-on-merge covers
   uncovered merges in a batch, commits the root version/changelog, and tags.
2. Watch **Release on merge**, CI, then **Deploy Staging**. Confirm the release
   manifest has four digests, Neon snapshot is confirmed before Railway edits,
   server migrations/functions pass, and all deployments reach success.
3. If GHCR pulls fail due to private packages, fix package visibility or
   registry credentials, then re-run the failing **Deploy Staging** run; the
   manifest is reused, so it does not rebuild. Never retry to bypass failed CI
   or diagnose failures by skipping snapshot/migration checks.
4. Confirm workflow smoke and `deploy/staging` success on the tagged release
   commit. Smoke checks `/healthz` (version/SHA), `/readyz`, root redirect and
   callback, `/login` (release headers), and a WebSocket upgrade (opens then
   closes `4401 auth_failed`). A `schema_behind` or `schema_divergent` 503 is
   a stop condition; inspect release and server logs.
5. Open **Actions → Deploy Production → Run workflow**, enter the complete tag,
   and approve the production deployment. It requires staging success and a
   matching manifest, takes a fresh snapshot, promotes the same digests, and
   runs the same runtime smoke.

   **Verify:** staging and production `deploy/*` statuses succeed on the
   release commit; `/healthz` reports the expected version and SHA; `/readyz`,
   app callback/login, and WebSocket checks pass.

## 6. Rollback and database restore

**Application rollback:** dispatch production with an older tag that has
successful `deploy/staging`; approve it and verify its digests and smoke. This reuses the old images, not old workflow code, and does not reverse migrations. Migration history is forward-only; old application versions must tolerate the newer schema/functions. If not, roll forward with a fix rather than assuming an image rollback restores data.

**Restore:** roll back/select the application image first, then restore the
Neon snapshot to a new branch, verify it, finalize, and only then point Railway at it. Pause/scale down traffic during cutover. Rehearse with a disposable branch first.

1. From GitHub environment variables and deploy logs obtain `NEON_PROJECT_ID`,
   `NEON_API_KEY`, source `NEON_BRANCH_ID`, and the snapshot ID. Request restore
   without finalizing:

   ```sh
   export NEON_API_KEY='...'; export NEON_PROJECT_ID='...'
   export SNAPSHOT_ID='...'; export TARGET_BRANCH_ID='...'
   curl --fail-with-body -sS -X POST \
     "https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}/snapshots/${SNAPSHOT_ID}/restore" \
     -H "Authorization: Bearer ${NEON_API_KEY}" -H 'Content-Type: application/json' \
     -d "{\"name\":\"restore-${SNAPSHOT_ID}\",\"target_branch_id\":\"${TARGET_BRANCH_ID}\",\"finalize_restore\":false}" | tee restore-response.json
   jq . restore-response.json
   ```

2. Record returned restore branch ID; wait for its operation to finish. Verify
   branch, compute, direct connection, data, and app-specific checks. Do not
   finalize an unverified branch.
3. After approval, finalize the restored branch:

   ```sh
   export RESTORE_BRANCH_ID='...'
   curl --fail-with-body -sS -X POST \
     "https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}/branches/${RESTORE_BRANCH_ID}/finalize_restore" \
     -H "Authorization: Bearer ${NEON_API_KEY}" -H 'Content-Type: application/json' \
     -d '{"name":"pre-restore-original"}' | jq .
   ```

4. Get the finalized branch's direct URL. Update Railway server `DATABASE_URL`
   and (if used) www `WEB_DATABASE_URL` using `railway variable set --stdin
   --skip-deploys`; update GitHub `NEON_BRANCH_ID` for future snapshots. Restart
   services and verify `/readyz`, application behavior, and recovered data.

   **Verify:** restored branch is serving the expected data, readiness is
   healthy, Railway and GitHub point to the restored branch, and the original
   branch is retained until recovery is accepted.

## 7. Expand/contract and local rehearsal

Migrations run before new code; old code may run against the expanded schema, and rollback code runs against the newest schema. Keep N-1 compatibility:

1. **Expand:** add nullable fields/tables/indexes or compatible functions;
   deploy code that reads and writes old and new forms.
2. **Backfill:** migrate in bounded, resumable batches; preserve old reads.
3. **Switch:** deploy code using the new form while retaining prior-release
   compatibility; verify it.
4. **Contract later:** remove old fields/functions only after no rollback
   image needs them. Do not combine destructive rename/drop or incompatible
   type/meaning changes with the rollout that stops using the old shape.

Local production-shaped rehearsal builds all four images, backs up Postgres, then migrates before serving traffic. From repository root:

```sh
export MERIDIAN_VERSION=0.0.0-local
export MERIDIAN_RELEASE_SHA="$(git rev-parse HEAD)"
docker compose -f tools/deploy/local/compose.yml up --build -d
node tools/deploy/smoke-check.ts http://meridian.localtest.me:18080 --expect-version "$MERIDIAN_VERSION" --expect-release "$MERIDIAN_RELEASE_SHA"
docker compose -f tools/deploy/local/compose.yml down -v
```

**Verify:** backup and release one-shots complete; smoke table reports PASS for
healthz, readyz, app root redirect, login, and WebSocket; then `down -v` removes the local DB and backup volume. Never substitute a different host: the WorkOS callback uses the same public origin.

### First-run checks

- Verify actual Neon region/scale-to-zero/history settings, snapshot API result,
  quota, expiry, restore and finalize behavior.
- Verify Railway image-source deploy and pre-deploy behavior, DNS refresh,
  bucket variable references, one-replica/draining settings, registry access,
  and no scale-to-zero.
- Verify WorkOS callback registration and production reviewer availability.
- Check that the 10 MB ingress body limit is adequate before accepting larger
  uploads.
