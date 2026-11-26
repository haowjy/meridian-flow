#!/usr/bin/env bash
set -euo pipefail

PG_BIGM_TAG="v1.2-20250903"
PG_BIGM_SHA256="4d4fb48161e3f9e99207851299379c83b3e5d1d3c1a07c35f6a3153d577b3142"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

curl -fsSL -o "$workdir/pg_bigm.tar.gz" "https://github.com/pgbigm/pg_bigm/archive/refs/tags/${PG_BIGM_TAG}.tar.gz"
echo "${PG_BIGM_SHA256}  $workdir/pg_bigm.tar.gz" | sha256sum -c -
tar xz -C "$workdir" -f "$workdir/pg_bigm.tar.gz"
cd "$workdir"/pg_bigm-*
make USE_PGXS=1 with_llvm=no
${SUDO:-} make USE_PGXS=1 with_llvm=no install
