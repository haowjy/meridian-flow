#!/usr/bin/env bash
# Configure Railway runtime behavior and non-secret references for one environment.
set -euo pipefail

usage() { echo "Usage: bash tools/deploy/railway/configure.sh <staging|production>" >&2; exit 2; }
[[ $# == 1 && ( "$1" == staging || "$1" == production ) ]] || usage
environment=$1
command -v railway >/dev/null || { echo "Railway CLI 5.62.1 is required; install it with npm i -g @railway/cli@5.62.1" >&2; exit 1; }
[[ -n ${RAILWAY_TOKEN:-} ]] || { echo "RAILWAY_TOKEN is required; authenticate for the $environment environment before configuring it." >&2; exit 1; }
version=$(railway --version)
[[ $version == *5.62.1* ]] || { echo "Railway CLI 5.62.1 required, found: $version" >&2; exit 1; }

edit() { railway environment edit -e "$environment" --service-config "$1" "$2" "$3" -m "Configure Meridian $environment runtime"; }
configure_service() {
  local service=$1 port=$2 health=$3 predeploy=${4:-}
  edit "$service" deploy.healthcheckPath "$health"
  edit "$service" deploy.healthcheckTimeout 300
  edit "$service" deploy.restartPolicyType ON_FAILURE
  edit "$service" deploy.drainingSeconds 30
  edit "$service" deploy.overlapSeconds 0
  edit "$service" deploy.numReplicas 1 # Verify the first deployment's UI renders one replica.
  [[ -z $predeploy ]] || edit "$service" deploy.preDeployCommand '["node","/app/release/release.mjs"]'
  edit "$service" variables.NODE_ENV production
  edit "$service" variables.APP_ENV production
  edit "$service" variables.HOST ::
  edit "$service" variables.PORT "$port"
}
configure_service server 3001 /readyz release
edit server variables.API_REPLICA_COUNT.value 1
edit server variables.DATABASE_URL.value '${{Postgres.DATABASE_URL}}'
edit server variables.MERIDIAN_BACKENDS.value live
edit server variables.OBJECT_STORE_PROVIDER.value s3
edit server variables.S3_BUCKET.value '${{Backups.BUCKET}}' # Unverified Railway Bucket preset key; verify in Credentials UI.
edit server variables.S3_ENDPOINT.value '${{Backups.ENDPOINT}}' # Unverified Railway Bucket preset key; verify in Credentials UI.
edit server variables.S3_REGION.value '${{Backups.REGION}}' # Unverified Railway Bucket preset key; verify in Credentials UI.
edit server variables.S3_ACCESS_KEY.value '${{Backups.ACCESS_KEY_ID}}' # Unverified Railway Bucket preset key; verify in Credentials UI.
edit server variables.S3_SECRET_KEY.value '${{Backups.SECRET_ACCESS_KEY}}' # Unverified Railway Bucket preset key; verify in Credentials UI.
edit server variables.BACKUP_S3_BUCKET.value '${{Backups.BUCKET}}' # Unverified Railway Bucket preset key; verify in Credentials UI.
edit server variables.BACKUP_S3_ENDPOINT.value '${{Backups.ENDPOINT}}' # Unverified Railway Bucket preset key; verify in Credentials UI.
edit server variables.BACKUP_S3_REGION.value '${{Backups.REGION}}' # Unverified Railway Bucket preset key; verify in Credentials UI.
edit server variables.BACKUP_S3_ACCESS_KEY_ID.value '${{Backups.ACCESS_KEY_ID}}' # Unverified Railway Bucket preset key; verify in Credentials UI.
edit server variables.BACKUP_S3_SECRET_ACCESS_KEY.value '${{Backups.SECRET_ACCESS_KEY}}' # Unverified Railway Bucket preset key; verify in Credentials UI.
configure_service app 3000 /login
edit app variables.MERIDIAN_API_ORIGIN.value http://server.railway.internal:3001
configure_service www 3002 /
configure_service ingress 8080 /_ingress/health
edit ingress variables.APP_UPSTREAM.value app.railway.internal:3000
edit ingress variables.SERVER_UPSTREAM.value server.railway.internal:3001

cat <<EOF2

Configuration applied for $environment. source.image is intentionally untouched; deploy.ts owns digest promotion.
GHCR container packages start private: link each package to this repository and set it public in its package settings, or configure Railway deploy.registryCredentials manually.
Set these secret values manually in the Railway $environment environment (names only):
  server: WORKOS_API_KEY, WORKOS_CLIENT_ID, WORKOS_COOKIE_PASSWORD, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY
  app: WORKOS_API_KEY, WORKOS_CLIENT_ID, WORKOS_COOKIE_PASSWORD, WORKOS_REDIRECT_URI, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
  Example, without exposing the value in shell history:
    read -rsp 'Secret value: ' VALUE; echo; printf %s "$VALUE" | railway variable set -s server -e $environment --skip-deploys --stdin WORKOS_API_KEY; unset VALUE
EOF2
