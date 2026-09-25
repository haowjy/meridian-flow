# Deployment operations

Deploys take and verify a Neon snapshot before any Railway service changes.
The server image's pre-deploy command then applies pending migrations and
functions before the new image starts. A later production release can be
rolled back to an older staging-verified image digest, but database changes
remain forward-only. Use this page for deploy failures, rollback, recovery, and
schema changes.

## What a deploy runs

1. A `main` merge is versioned by `release-on-merge.yml`; it writes a
   `release: vX.Y.Z` commit and tag using `RELEASE_TOKEN`.
2. CI runs on the release commit. Only a successful CI run for that release
   commit starts staging deployment.
3. Staging validates its GitHub environment config and downloads the release
   manifest from the GitHub Release. Manifest image repositories, digests, tag,
   and release SHA are checked before deployment.
4. `tools/deploy/deploy.ts` creates a named Neon branch snapshot with the
   configured expiry. It polls the operation, requires status `finished` and
   zero failures, and confirms the snapshot exists on the target branch. Any
   missing ID, API error, non-success operation, timeout, malformed response,
   or missing snapshot stops before Railway is edited.
5. The seam edits the server's digest `source.image` and
   `MERIDIAN_BACKUP_REF=neon-snapshot:<snapshot-id>:release=<sha>` together.
   The server image's Railway pre-deploy command runs
   `node /app/release/release.mjs`. It uses direct `DATABASE_URL`, applies
   migrations and functions atomically, and refuses pending migrations unless
   the snapshot ref matches the image's baked `MERIDIAN_RELEASE_SHA`.
6. The seam edits the remaining app, WWW, and ingress `source.image` digests
   and waits until each Railway deployment reaches success. It does not treat
   the CLI command returning as runtime evidence.
7. Smoke probes the public ingress: server liveness and readiness, expected
   version and SHA, app redirect/login HTML and response headers, and the
   unauthenticated Yjs websocket upgrade (must open then close `4401
   auth_failed`). The workflow sets `deploy/staging` success only after both
   deploy and smoke succeed. Production promotion uses those exact manifest
   digests and also runs smoke before it can set `deploy/production` success.

### Failure boundaries

| Failure | What stops | Next check |
|---|---|---|
| Missing GitHub secret/variable or invalid URL | Deployment before manifest or Railway work | GitHub → Settings → Environments → `staging` or `production`; check the explicit missing-input message. |
| Invalid/missing manifest or tag mismatch | Deployment before Neon or Railway work | GitHub Release asset `release-manifest.json`; compare tag, root version, full SHA, and four digest refs. |
| Snapshot operation or snapshot-list confirmation fails | Deployment before any Railway environment edit | Neon project/branch IDs, project-scoped Editor key, snapshot API response/operation, and branch snapshot list. Do not bypass the snapshot gate. |
| Railway image edit/deploy fails | That service deploy fails; later server-first flow does not continue after server failure; app/www/ingress deploys run concurrently after server succeeds | Use the exact command in the failure output: `railway logs -s <service> -e <staging|production> <deployment-id> --deployment`. Check image source/registry access, `pre-deploy` and service logs. |
| Release command fails | Server pre-deploy fails; new server image does not start | Read server deployment logs. Check direct `DATABASE_URL`, snapshot ref matches release SHA, pending SQL/functions, and N-1 compatibility. |
| `/readyz` returns 503 | Health/readiness and post-deploy smoke fail | `schema_behind` means database migrations trail this image's expected schema; `schema_divergent` means migration history differs from the image chain. Stop rollout and investigate; do not force readiness. |
| Version/SHA, app, WWW or WebSocket smoke fails | Environment status is failure; production version cannot be promoted unless staging status is success | Check Caddy service config, public domain, `APP_UPSTREAM`/`SERVER_UPSTREAM`, private DNS and app/server deployment logs. |

Staging can retry an existing built release without rebuilding:
GitHub → Actions → **Deploy Staging** → **Run workflow**, input `version`
without leading `v` (for example `1.2.3`). It takes a fresh snapshot and
reapplies the same manifest digests. Do not use this to bypass failed CI or
smoke diagnostics.

## Roll back application code

A rollback is a manual production promotion of a previous version whose
`deploy/staging` commit status is successful. It reuses that release's exact
image digests; it does not rebuild the image or reverse migrations.

1. In GitHub, open **Actions → Deploy Production → Run workflow**.
2. Set `version` to the prior tag including `v`, for example `v1.2.3`, then
   run the workflow.
3. A reviewer approves the `production` environment job. Verify the workflow
   says the version had a successful staging deployment, downloads a manifest
   whose SHA matches the tag, deploys all four digests, and passes runtime
   smoke.
4. Verify GitHub commit status `deploy/production` and check `/healthz` for
   the expected version and SHA.

Migrations are forward-only. When a rollback bundle finds that the DB is ahead
of its migration chain, the release runner treats it as zero pending
migrations; it does not reapply earlier SQL. The runner also skips applying
function files on a database ahead of that rollback bundle. This avoids
replacing newer functions with older definitions. It does not guarantee the
older app works against a newer schema: every change needs N-1 compatibility
until old application images are no longer part of a deploy/rollback path.
If the old version cannot work against the current schema, roll forward with a
fix rather than assuming image rollback restores data/schema.

## Restore database data

Restore is a deliberate cutover, not an automatic deploy rollback. Keep the
current branch and its Railway `DATABASE_URL` unchanged until the restored
branch has been verified. Snapshot restore creates a new branch first; only
finalize after checks pass. Confirm current Neon API response fields in a
non-production rehearsal before operating on production.

### Restore a pre-deploy snapshot

1. Obtain `NEON_API_KEY`, `NEON_PROJECT_ID`, and the snapshot ID from GitHub
   environment configuration, release/deploy logs, and Neon → project →
   **Backups & Restore → Snapshots**. Never paste API keys into shared logs.
2. Request restore without finalizing. `target_branch_id` is the branch the
   snapshot came from; `name` creates an identifiable recovery branch. The
   returned branch ID is called `RESTORE_BRANCH_ID` below.

   ```sh
   export NEON_API_KEY='...'
   export NEON_PROJECT_ID='...'
   export SNAPSHOT_ID='...'
   export TARGET_BRANCH_ID='...'
   curl --fail-with-body -sS -X POST \
     "https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}/snapshots/${SNAPSHOT_ID}/restore" \
     -H "Authorization: Bearer ${NEON_API_KEY}" \
     -H 'Content-Type: application/json' \
     -d "{\"name\":\"restore-${SNAPSHOT_ID}\",\"target_branch_id\":\"${TARGET_BRANCH_ID}\",\"finalize_restore\":false}" \
     | tee restore-response.json
   jq . restore-response.json
   ```

3. Read the new branch id from the response; wait for any returned operation to
   finish successfully using
   `GET /api/v2/projects/$NEON_PROJECT_ID/operations/$OPERATION_ID`. Inspect
   the branch in Neon Console and confirm its role, database, compute, and
   data. Connect with a direct connection string and run application-specific
   checks before cutover. If the restored branch needs a compute, create/attach
   one in Neon Console before retrieving its connection string.
4. After approval, finalize the new branch as the replacement for the original
   branch. This reassigns computes, restarts them, renames the restored branch
   to the original name and the original branch to a backup name.

   ```sh
   export RESTORE_BRANCH_ID='...'
   curl --fail-with-body -sS -X POST \
     "https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}/branches/${RESTORE_BRANCH_ID}/finalize_restore" \
     -H "Authorization: Bearer ${NEON_API_KEY}" \
     -H 'Content-Type: application/json' \
     -d '{"name":"pre-restore-original"}' | jq .
   ```

5. Retrieve the finalized branch's **direct** connection string from Neon
   Console → **Connect**. In Railway, update the server's `DATABASE_URL` and
   WWW's `WEB_DATABASE_URL` (if used) in the correct environment. Use stdin so
   the secret does not enter shell history:

   ```sh
   read -rsp 'New direct Neon URL: ' VALUE; echo
   printf %s "$VALUE" | railway variable set -s server -e production --skip-deploys --stdin DATABASE_URL
   unset VALUE
   ```

   Repeat with `-s www` and `WEB_DATABASE_URL` if the WWW service uses this DB.
   Redeploy/restart server and WWW, then verify `/readyz` is HTTP 200 with
   `ready: true`, app behavior, and database contents. If the branch now has a
   different ID, also update GitHub production variable `NEON_BRANCH_ID`; the
   next production deploy snapshots exactly that ID. Retain the original branch
   until recovery is accepted and backups are confirmed.

The operation names and payloads above follow Neon API:
[restore snapshot](https://api-docs.neon.tech/reference/restoresnapshot) and
[finalize branch restore](https://api-docs.neon.tech/reference/finalizerestorebranch).
Snapshot creation is asynchronous; the deployment seam checks its operation
and lists the snapshot before proceeding ([create snapshot](https://api-docs.neon.tech/reference/createsnapshot), [get operation](https://api-docs.neon.tech/reference/getprojectoperation), [list snapshots](https://api-docs.neon.tech/reference/listsnapshots)).

### Point-in-time recovery (PITR)

To create a new branch at a timestamp or LSN, use the branch restore endpoint.
This preserves the existing branch and returns a new branch to verify before
changing Railway:

```sh
export NEON_API_KEY='...'
export NEON_PROJECT_ID='...'
export SOURCE_BRANCH_ID='...'
curl --fail-with-body -sS -X POST \
  "https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}/branches/${SOURCE_BRANCH_ID}/restore" \
  -H "Authorization: Bearer ${NEON_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{"source_branch_id":"'"${SOURCE_BRANCH_ID}"'","source_timestamp":"2026-09-24T12:00:00Z","preserve_under_name":"pre-pitr-original"}' | jq .
```

Use an RFC 3339 timestamp within the Neon history window; to restore by LSN,
replace `source_timestamp` with `source_lsn`. Save the response's new branch
ID, provision/attach a read-write compute, verify the data, and cut over Railway
`DATABASE_URL` as above. Update GitHub `NEON_BRANCH_ID` to the recovery branch
for future snapshots. See Neon [restore branch to a historical state](https://api-docs.neon.tech/reference/restoreprojectbranch) and [create branch](https://api-docs.neon.tech/reference/createprojectbranch).

## Expand/contract migration rules

Migrations run **before** new application code starts. During deployment, the
old application code can run against the new schema. During rollback, older
code runs against the newest schema. Every release must preserve that N-1
compatibility.

Use this order:

1. **Expand:** add nullable columns, tables, indexes, or functions without
   removing or changing the meaning of existing objects. Deploy code that can
   read/write both old and new representations.
2. **Backfill:** migrate existing data in a safe bounded process; keep old
   reads working. For large data, use resumable batches rather than a long
   deployment-time lock.
3. **Switch:** deploy code that reads the new representation while retaining
   compatibility with the prior release. Observe and verify.
4. **Contract later:** in a later release, after no rollback candidate needs
   old fields/functions, remove deprecated columns/indexes or old behavior.

Forbidden in one release: rename/drop a column still used by the old image;
change a column type or meaning incompatibly; make a nullable field required
before backfill and compatible code; replace a function signature while old
code may call it; drop a table and add its replacement in one step; or change
an enum/constraint so current records or old writes fail unexpectedly.

Migration lint catches patterns needing human review and is strict for PRs
bound for `main`; warnings are a cue to demonstrate compatibility, not a
substitute for this rule or proof that a migration is safe. SQL function files
are applied atomically with migrations. Keep function names and signatures
stable across releases; add a new signature/overload first and remove the old
one only in a later contract release. A DB-ahead rollback skips function files
so it cannot downgrade function definitions.

For local production-shaped end-to-end checks, see the separate
[local deployment stack guide](../../tools/deploy/local/README.md).
