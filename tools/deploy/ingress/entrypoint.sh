#!/bin/sh
set -eu

split_upstream() {
  name="$1"
  value="$2"
  case "$value" in
    *:*) ;;
    *) echo "$name must be a host:port value" >&2; exit 1 ;;
  esac
  host=${value%:*}
  port=${value##*:}
  case "$port" in
    ''|*[!0-9]*) echo "$name must end in a numeric port" >&2; exit 1 ;;
  esac
  case "$host" in
    ''|*/*|*' '*|*'?'*|*'#'*) echo "$name must contain a valid hostname or IP address" >&2; exit 1 ;;
  esac
  case "$name" in
    APP_UPSTREAM) APP_UPSTREAM_HOST=$host; APP_UPSTREAM_PORT=$port ;;
    SERVER_UPSTREAM) SERVER_UPSTREAM_HOST=$host; SERVER_UPSTREAM_PORT=$port ;;
  esac
}

: "${APP_UPSTREAM:?APP_UPSTREAM must be set as host:port}"
: "${SERVER_UPSTREAM:?SERVER_UPSTREAM must be set as host:port}"
split_upstream APP_UPSTREAM "$APP_UPSTREAM"
split_upstream SERVER_UPSTREAM "$SERVER_UPSTREAM"
export APP_UPSTREAM_HOST APP_UPSTREAM_PORT SERVER_UPSTREAM_HOST SERVER_UPSTREAM_PORT
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
