#!/usr/bin/env bash
# Builds and installs the pinned pg_bigm against the Postgres on PATH (pg_config).
# Shared by the Dockerfile and the CI db-tests job so both run the same extension build.
# PGDG ships no pg_bigm package, so this compiles the tagged source. Needs
# build-essential, libicu-dev, curl and the server dev headers (postgresql-server-dev-N).
set -euo pipefail

PG_BIGM_TAG="v1.2-20250903"
PG_BIGM_SHA256="4d4fb48161e3f9e99207851299379c83b3e5d1d3c1a07c35f6a3153d577b3142"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

curl -fsSL -o "$workdir/pg_bigm.tar.gz" "https://github.com/pgbigm/pg_bigm/archive/refs/tags/${PG_BIGM_TAG}.tar.gz"
echo "${PG_BIGM_SHA256}  $workdir/pg_bigm.tar.gz" | sha256sum -c -
tar xz -C "$workdir" -f "$workdir/pg_bigm.tar.gz"
cd "$workdir"/pg_bigm-*
# with_llvm=no skips the JIT bitcode, which needs clang that the CI runner does not install.
make USE_PGXS=1 with_llvm=no
${SUDO:-} make USE_PGXS=1 with_llvm=no install
