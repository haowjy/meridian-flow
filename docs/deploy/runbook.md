# First staging deploy and production promotion

Provision one Neon project/branch and one Railway project with `staging` and
`production` environments. The GitHub release workflow builds four images
once; Railway receives immutable GHCR digests. The production workflow only
promotes a version that completed staging smoke and waits for a human approval.

## 1. Prepare GitHub release and deployment controls

1. **Confirm repository visibility and token authority.** Go to GitHub
   repository → **Settings → Rules → Rulesets** and confirm `protect` on `main`
   allows the release actor to bypass its required PR rule. Create a
   fine-grained PAT belonging to a repository admin, scoped only to this repo
   with Contents read/write, or use a GitHub App with Contents read/write and
   add the App as a bypass actor to both `protect` and the tag ruleset. A
   normal `GITHUB_TOKEN` is not a substitute: its pushes do not trigger the
   required downstream CI.
2. **Add the version-tag ruleset.** From the repository root, use an admin
   `gh` login and apply the committed ruleset (currently grants the repository
   admin role bypass):

   ```sh
   gh api --method POST repos/haowjy/meridian-flow/rulesets \
     --input docs/deploy/tag-ruleset.json
   gh api repos/haowjy/meridian-flow/rulesets \
     --jq '.[] | select(.name == "Protect version tags") | {id,name,enforcement,conditions,rules}'
   ```

   Verify the result targets `refs/tags/v*` and blocks tag update/deletion.
   For an App bypass, edit the committed JSON to the App's actor ID/type before
   applying; do not leave it as an undocumented manual exception.
3. **Create environments.** Go to **Settings → Environments → New
   environment** and create exactly `staging` and `production`. Add required
   reviewers under production deployment protection rules. GitHub Free supports
   required reviewers for public repositories; on Free they are unavailable
   for private repositories ([GitHub environment documentation][gh-env]).
4. **Set the release secret.** Add repository secret `RELEASE_TOKEN` at
   **Settings → Secrets and variables → Actions → Repository secrets → New
   repository secret**. Or set from a prompt:

   ```sh
   read -rsp 'Admin PAT or bypass App token: ' VALUE; echo
   printf %s "$VALUE" | gh secret set RELEASE_TOKEN --repo haowjy/meridian-flow
   unset VALUE
   ```

5. **Set each environment's secrets and variables.** For each environment,
   repeat with its matching Railway and Neon project/branch credentials. GitHub
   CLI writes secret input from stdin and ordinary variables directly:

   ```sh
   ENV=staging # repeat with ENV=production
   read -rsp "${ENV} Railway project token: " VALUE; echo
   printf %s "$VALUE" | gh secret set RAILWAY_TOKEN --env "$ENV" --repo haowjy/meridian-flow
   unset VALUE
   read -rsp "${ENV} Neon project-scoped Editor API key: " VALUE; echo
   printf %s "$VALUE" | gh secret set NEON_API_KEY --env "$ENV" --repo haowjy/meridian-flow
   unset VALUE

   gh variable set NEON_PROJECT_ID --env "$ENV" --body '<project-id>' --repo haowjy/meridian-flow
   gh variable set NEON_BRANCH_ID --env "$ENV" --body '<branch-id>' --repo haowjy/meridian-flow
   gh variable set PUBLIC_URL --env "$ENV" --body 'https://<ingress-domain>' --repo haowjy/meridian-flow
   ```

   `PUBLIC_URL` can be updated once the ingress Railway domain is known. It
   must include `https://` and is also the Actions deployment URL.

**Verify:** GitHub settings show two environments, required reviewers on
`production`, and the named secrets/variables in the correct scope. Do not
print or paste secret values into terminal logs. A missing field is an explicit
deploy failure.

## 2. Create Neon production and staging targets

1. In Neon, create or select the organization that owns production. Before
   choosing a region, query the region API for this organization and confirm
   the response contains `aws-us-east-1`:

   ```sh
   read -rsp 'Neon API key: ' NEON_API_KEY; echo
   curl --fail-with-body -sS \
     -H "Authorization: Bearer $NEON_API_KEY" \
     'https://console.neon.tech/api/v2/regions?org_id=<organization-id>' | jq .
   unset NEON_API_KEY
   ```

   **Verify:** the returned region list includes `aws-us-east-1`; if it does
   not, use `aws-us-east-2`. The chosen region is not guessed from a global
   availability list; it must be enabled for this org.
2. Create the production project on **Launch** in `aws-us-east-1` (or
   `aws-us-east-2` fallback), PostgreSQL 16. Configure autoscaling min/max CU
   explicitly, disable scale-to-zero (keep compute always on), and choose a
   history window that covers the operational recovery objective. Validate
   the current Console/API controls and actual applied values; the exact
   scale-to-zero disable API value remains a first-run verification item.
3. Create a separate staging Launch project in the same region for credential
   and project-level isolation. A staging branch under production is the
   lower-cost alternative but shares project authority; if chosen, strictly
   pin the correct branch ID in staging GitHub variables.
4. In each project, copy its direct connection URL. Set the app/migration
   connection to a direct hostname with no `-pooler`, preserve
   `sslmode=require`, and remove `channel_binding=require`. The application
   keeps `LISTEN thread_events` open and postgres.js does not implement
   SCRAM-SHA-256-PLUS; see the [Postgres host decision][postgres].
5. Create a Neon **organization API key scoped to the specific project** for a
   dedicated automation collaborator with Editor access. Store it only as
   GitHub environment secret `NEON_API_KEY`, one key per environment. Record
   the project ID and exact branch ID, then set the matching GitHub
   `NEON_PROJECT_ID` and `NEON_BRANCH_ID` variables in step 1.

**Verify:** connect using the direct URL with a PostgreSQL client; confirm the
project ID, branch ID, region, Postgres version, autoscaling range, always-on
setting, and history window. Rehearse snapshot creation and restore in staging.
The deploy expects snapshot create to return an operation ID, polls to
`finished` with `failures_count: 0`, then requires the named snapshot in the
branch snapshot list. Confirm that response shape against a disposable branch
before first production migration; HTTP 2xx alone is not enough.

## 3. Create Railway project and services

1. Create a **new Railway project**; do not reuse the old v1 Railway project.
   Select the Virginia region (`us-east4-eqdc4a`) for every service. Create
   Railway environments named `staging` and `production`.
2. In each environment add empty services named exactly `server`, `app`,
   `www`, and `ingress`. Set their source to a container image/registry source
   compatible with GHCR images. Do not add a Postgres service; the selected
   database is Neon.
3. In each environment create an object-storage bucket credential/service
   named `uploads`. Verify the credential preset keys exposed by Railway:
   `BUCKET`, `ENDPOINT`, `PUBLIC_ENDPOINT`, `REGION`, `ACCESS_KEY_ID`, and
   `SECRET_ACCESS_KEY`. These exact reference names are first-run verification
   items; `configure.sh` writes references using those names. If Railway's
   UI/API uses different names, set the server's `S3_*` values manually as
   described in step 5. Ensure the bucket is private unless the product's
   signed/public URL contract calls for public access.
4. Create a separate **project-scoped Railway token for each environment** and
   place them in the corresponding GitHub `RAILWAY_TOKEN` environment
   secrets. Install the pinned CLI and configure each environment from the
   checkout root. `configure.sh` must be run with the matching token/project:

   ```sh
   pnpm add -g @railway/cli@5.62.1
   railway --version
   railway link # select the new Railway project
   export RAILWAY_TOKEN='<staging-project-token>'
   bash tools/deploy/railway/configure.sh staging
   unset RAILWAY_TOKEN
   export RAILWAY_TOKEN='<production-project-token>'
   bash tools/deploy/railway/configure.sh production
   unset RAILWAY_TOKEN
   ```

   **Verify:** the output reports successful configuration. In each
   environment, check service settings for one replica, `/readyz` server
   healthcheck, `/login` app healthcheck, `/` WWW healthcheck, ingress
   `/_ingress/health`, restart-on-failure, 30-second draining, and zero-second
   overlap. Verify server `deploy.preDeployCommand` is
   `node /app/release/release.mjs`. On image-source services, verify a service
   source image edit actually triggers a deployment, and verify the
   pre-deploy command runs for the server image source. These are first-run
   checks: Railway documentation has not conclusively established both
   behaviors for image-sourced services.
5. **Set Railway runtime secrets without shell history.** Railway CLI context
   must be linked to this project. Set these secret values in each environment;
   each CLI command uses `--stdin` and `--skip-deploys` so partial configuration
   does not deploy before the whole set is ready:

   ```sh
   ENV=staging # repeat with ENV=production
   read -rsp 'Direct Neon DATABASE_URL: ' VALUE; echo
   printf %s "$VALUE" | railway variable set -s server -e "$ENV" --skip-deploys --stdin DATABASE_URL
   unset VALUE
   read -rsp 'WorkOS API key: ' VALUE; echo
   printf %s "$VALUE" | railway variable set -s server -e "$ENV" --skip-deploys --stdin WORKOS_API_KEY
   printf %s "$VALUE" | railway variable set -s app -e "$ENV" --skip-deploys --stdin WORKOS_API_KEY
   unset VALUE
   read -rsp 'WorkOS client id: ' VALUE; echo
   printf %s "$VALUE" | railway variable set -s server -e "$ENV" --skip-deploys --stdin WORKOS_CLIENT_ID
   printf %s "$VALUE" | railway variable set -s app -e "$ENV" --skip-deploys --stdin WORKOS_CLIENT_ID
   unset VALUE
   read -rsp 'WorkOS cookie password (32+ chars): ' VALUE; echo
   printf %s "$VALUE" | railway variable set -s server -e "$ENV" --skip-deploys --stdin WORKOS_COOKIE_PASSWORD
   printf %s "$VALUE" | railway variable set -s app -e "$ENV" --skip-deploys --stdin WORKOS_COOKIE_PASSWORD
   unset VALUE
   read -rsp 'One live model-provider key: ' VALUE; echo
   printf %s "$VALUE" | railway variable set -s server -e "$ENV" --skip-deploys --stdin OPENAI_API_KEY
   unset VALUE
   ```

   Repeat the provider-key step with `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`,
   or `OPENROUTER_API_KEY` if using that provider. Add at least one live model
   provider key. For staging, WorkOS test API keys are allowed; production
   requires a real non-test WorkOS key. Do not set development login variables.
   If bucket preset references verified successfully, server S3 credentials are
   resolved through them. Otherwise set `S3_BUCKET`, `S3_ENDPOINT`,
   `S3_PUBLIC_ENDPOINT`, `S3_REGION` with `railway variable set` and set
   `S3_ACCESS_KEY`/`S3_SECRET_KEY` via the same secret stdin pattern.
6. **Attach public domains.** In Railway, open `ingress` in each environment →
   **Settings → Networking → Public Networking → Generate Domain**. Add the
   optional custom domain and DNS records there if desired. Add a Railway
   public domain (or custom domain) to `www` separately for the marketing site.
   Keep the app public origin on ingress, not `app` or `server`. Put the full
   HTTPS ingress URL in GitHub `PUBLIC_URL` for that environment.
7. **Verify the deploy defaults.** In the ingress and app/service settings,
   check that a source image edit auto-deploys and the service's explicit
   redeploy path works. `deploy.ts` can invoke
   `railway redeploy --from-source` when it does not observe a new deployment
   after an image edit; ensure this reuses the configured `source.image` rather
   than rebuilding code. Confirm Railway scale-to-zero is disabled for the
   server, app, www, and ingress; service replicas stay at one. Check Railway's
   supported drain setting/value and ensure the server has the intended 30
   seconds. These first-run verifications are required before launch.

**Verify:** Railway shows the four services in both environments, every
service is in Virginia, the app's `MERIDIAN_API_ORIGIN` points to the private
server URL, ingress upstream variables point to private app/server URLs, and
the bucket-derived S3 values resolve. Service state remains intentionally
un-deployed until the first GHCR images exist.

## 4. Configure WorkOS

In WorkOS Dashboard, create/select the staging and production environments and
configure AuthKit for each. Add the redirect URI exactly as
`https://<ingress-host>/api/auth/callback` to its environment's Redirects list.
Generate a distinct strong cookie password for each Railway environment; use
at least 32 characters. Set WorkOS API key, client ID, cookie password, and
redirect URI to server and app Railway services per the [environment contract](./README.md#environment-contract).

**Verify:** WorkOS lists the exact callback URI for each public app origin;
the WorkOS credentials map to the corresponding environment and the app's
redirect host matches the ingress domain.

## 5. Make GHCR images deployable

GitHub Actions pushes the four image packages under `ghcr.io/haowjy/` on the
first successful staging build. New GHCR packages start private. After the
first build, open each package's **Package settings → Change visibility** and
make it public, or configure Railway registry credentials for private image
pulls in both environments. Then rerun staging with GitHub **Actions → Deploy
Staging → Run workflow**, entering the built version without `v`; this deploys
the existing manifest, not a rebuild.

**Verify:** Railway can pull each `server`, `app`, `www`, and `ingress` digest.
If logs report unauthorized/manifest access, image visibility or registry
credentials are not ready; do not treat an image edit as a successful deploy.

## 6. Create the first release and staging deploy

Merge a PR to `main` with a release label. Strongest label wins when multiple
stable bump labels exist. An unlabeled merge creates a patch RC; `release:skip`
opts out. The release workflow writes root version, changelog, release commit,
and version tag; CI then runs on the release commit. After CI passes, the
staging workflow builds the four images and deploys them by digest.

Watch **Actions → Release on merge**, **CI**, and **Deploy Staging** in order.
In the deploy run, ensure the manifest lists all four digests, the snapshot
step completes before Railway image edits, the server migration pre-deploy
passes, and each Railway deployment reaches `SUCCESS`. The CLI returning is
not runtime verification.

Useful diagnosis commands (install/pin the same Railway CLI and link the
project):

```sh
railway deployment list -s server -e staging --limit 10 --json
railway logs -s server -e staging <deployment-id> --deployment
```

Deploy seam errors explain missing input, invalid manifest, failed Neon
snapshot confirmation, Railway state, or failed runtime smoke. A server
`/readyz` `503` with `schema_behind` means migrations did not bring the DB up
to this image's schema; `schema_divergent` indicates the DB migration history
is not the expected chain. Stop and diagnose rather than skip the release
command or force readiness. See [operations](./operations.md#what-a-deploy-runs).

The workflow smoke table must show these passes:

| Probe | Pass condition |
|---|---|
| `/healthz` | HTTP 200, `status=ok`, `service=api`, expected version and release SHA |
| `/readyz` | HTTP 200 and `ready=true` |
| `/` | Redirect to `/login` |
| `/login` | HTTP 200, Meridian page title, expected version and SHA headers |
| `/ws/yjs` | WebSocket upgrade opens, then closes with `4401 auth_failed` (unauthenticated expected behavior) |
| Release status | GitHub commit status `deploy/staging` is success only after deploy and smoke pass |

**Verify:** GitHub **Deploy Staging** completed successfully, `deploy/staging`
is green on the release commit, and the live `/healthz` version/SHA match the
release. If www has a separate domain, check that domain's root returns 200.

## 7. Promote first production release

Before promotion, verify staging has run the candidate version and all
acceptance checks are green. In GitHub open **Actions → Deploy Production →
Run workflow** and enter its complete tag, for example `v0.1.0` (not the
version without `v`). The workflow refuses a missing tag, missing staging
success status, or manifest whose commit SHA does not match the tag. Approve
the waiting production deployment in **Actions → workflow run → Review
Deployments → Approve and deploy**. The job takes a fresh Neon snapshot, updates
the production Railway server image/ref, deploys the same four manifest
Digests, and runs the runtime smoke suite.

**Verify:** the workflow passes; GitHub status `deploy/production` is green on
the release commit; production `/healthz` reports the selected version and
release SHA; `/readyz`, app, and websocket checks pass. Review the Neon snapshot
and Railway server pre-deploy logs before calling the release complete.

## Cost at beta scale

The selected baseline—production and separate staging Neon Launch projects,
each at 0.25 CU with 2 GB storage—is estimated at about **$40.10/month**.
For Railway application hosting, start on **Hobby** for beta: its $5/month
minimum includes the first $5 of usage; resource usage above that is billed
extra. Thus the known plan floor is about **$45.10/month** for Neon plus
Railway, before any Railway usage above the included amount, taxes, Neon extra
history/snapshot storage, egress overage, and model-provider spend. Railway
usage depends on measured CPU, memory, network, and storage; after the first
week inspect Workspace settings → Usage and use the invoice to project a real
run rate. Move to Pro if team/workspace limits, capacity, or support needs
require it ([Railway pricing plans][railway-pricing]).

If production averaged 1 CU all month and staging stayed at 0.25 CU, Neon
would be about **$98.13/month**; with the Railway Hobby plan floor, that
scenario starts around **$103.13/month** before overages and other exclusions.
Actual autoscaling CU-time varies by workload. See the [accepted Postgres host
decision][postgres] for assumptions, competing options, and pricing sources.

[gh-env]: https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments#required-reviewers
[railway-pricing]: https://docs.railway.com/pricing/plans
[postgres]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/platform/hosting/postgres-host.md
