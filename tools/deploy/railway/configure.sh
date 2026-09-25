#!/usr/bin/env bash
# Configure stable Railway service settings and non-secret environment references.
set -euo pipefail

usage() { echo "Usage: bash tools/deploy/railway/configure.sh <staging|production>" >&2; exit 2; }
[[ $# == 1 && ( "$1" == staging || "$1" == production ) ]] || usage
environment=$1
command -v railway >/dev/null || { echo "Railway CLI 5.62.1 is required; install it with pnpm add -g @railway/cli@5.62.1" >&2; exit 1; }
[[ -n ${RAILWAY_TOKEN:-} ]] || { echo "RAILWAY_TOKEN is required; authenticate for the $environment environment before configuring it." >&2; exit 1; }
version=$(railway --version)
[[ $version == *5.62.1* ]] || { echo "Railway CLI 5.62.1 required, found: $version" >&2; exit 1; }

# Keep a single environment edit/commit so configuration cannot trigger a series of partial deploys.
args=(environment edit -e "$environment")
edit() { args+=(--service-config "$1" "$2" "$3"); }
service() {
  local name=$1 port=$2 health=$3 app_env=$4 predeploy=${5:-}
  edit "$name" deploy.healthcheckPath "$health"
  edit "$name" deploy.healthcheckTimeout 300 # Verify the first-run value is accepted by the service config API.
  edit "$name" deploy.restartPolicyType ON_FAILURE
  edit "$name" deploy.drainingSeconds 30
  edit "$name" deploy.overlapSeconds 0
  edit "$name" deploy.numReplicas 1
  [[ -z $predeploy ]] || edit "$name" deploy.preDeployCommand 'node /app/release/release.mjs'
  edit "$name" variables.NODE_ENV.value production
  edit "$name" variables.APP_ENV.value "$app_env"
  edit "$name" variables.HOST.value ::
  edit "$name" variables.PORT.value "$port"
}
service server 3000 /readyz "$environment" release
edit server variables.API_REPLICA_COUNT.value 1
edit server variables.MERIDIAN_BACKENDS.value live
edit server variables.OBJECT_STORE_PROVIDER.value s3
edit server variables.S3_BUCKET.value '${{uploads.BUCKET}}' # Verify the preset key spelling in Railway Credentials UI on first run.
edit server variables.S3_ENDPOINT.value '${{uploads.ENDPOINT}}' # Verify the preset key spelling in Railway Credentials UI on first run.
edit server variables.S3_PUBLIC_ENDPOINT.value '${{uploads.PUBLIC_ENDPOINT}}' # Verify that the uploads preset exposes this key; otherwise set manually.
edit server variables.S3_REGION.value '${{uploads.REGION}}' # Verify the preset key spelling in Railway Credentials UI on first run.
edit server variables.S3_ACCESS_KEY.value '${{uploads.ACCESS_KEY_ID}}' # Verify the preset key spelling in Railway Credentials UI on first run.
edit server variables.S3_SECRET_KEY.value '${{uploads.SECRET_ACCESS_KEY}}' # Verify the preset key spelling in Railway Credentials UI on first run.
service app 3000 /login "$environment"
edit app variables.MERIDIAN_API_ORIGIN.value http://server.railway.internal:3000
service www 3000 / "$environment"
edit www variables.WEB_DATABASE_URL.value '${{server.DATABASE_URL}}' # Railway cross-service reference; verify resolves on first deploy.
service ingress 8080 /_ingress/health "$environment"
edit ingress variables.APP_UPSTREAM.value app.railway.internal:3000
edit ingress variables.SERVER_UPSTREAM.value server.railway.internal:3000

args+=(-m "Configure Meridian $environment runtime")
railway "${args[@]}"

cat <<EOF2

Configuration applied for $environment. source.image and MERIDIAN_BACKUP_REF are intentionally untouched; deploy.ts owns both.
GHCR container packages start private: link each package to this repository and set it public in package settings, or configure Railway deploy.registryCredentials manually.
Set these secret values manually in the Railway $environment environment (names only):
  server: DATABASE_URL (Neon direct URL with sslmode=require; omit channel_binding and -pooler), WORKOS_API_KEY, WORKOS_CLIENT_ID, WORKOS_COOKIE_PASSWORD, S3_ACCESS_KEY, S3_SECRET_KEY
  model providers (at least one live key is required in staging/production): ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, OPENROUTER_API_KEY
  app: WORKOS_API_KEY, WORKOS_CLIENT_ID, WORKOS_COOKIE_PASSWORD
  app variable (not secret): WORKOS_REDIRECT_URI (use the public app URL plus /api/auth/callback)
If the uploads preset does not expose the referenced keys in Railway Credentials UI, set server variables S3_BUCKET, S3_ENDPOINT, S3_PUBLIC_ENDPOINT, S3_REGION, S3_ACCESS_KEY, and S3_SECRET_KEY manually (the last two are secrets).
Example, without exposing the value in shell history:
  read -rsp 'Secret value: ' VALUE; echo; printf %s "\$VALUE" | railway variable set -s server -e $environment --skip-deploys --stdin DATABASE_URL; unset VALUE
EOF2
