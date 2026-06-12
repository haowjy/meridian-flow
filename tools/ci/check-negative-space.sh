#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel)"
cd "$ROOT_DIR"

exec_runtime_word="sand""box"

rejected_paths=(
  "apps/server/server/domains/${exec_runtime_word}"
  "apps/server/server/lib/${exec_runtime_word}-runtime-factory.ts"
  "apps/server/server/domains/context/adapters/${exec_runtime_word}-aware-fs"
)

found=()
for path in "${rejected_paths[@]}"; do
  if [[ -e "$path" ]]; then
    found+=("$path")
  fi
done

while IFS= read -r hit; do
  found+=("$hit")
done < <(
  git grep -n \
    -e "Work""OS" \
    -e "work""os" \
    -e "markdown""-replace" \
    -e "Sand""boxProvider" \
    -e "Sand""boxScope" \
    -e "Sand""boxAwareFS" \
    -e "${exec_runtime_word}_preview" \
    -- \
    ':!.meridian/**' \
    ':!node_modules/**' \
    ':!pnpm-lock.yaml' \
    ':!apps/app/e2e/vertical-slice.spec.ts' \
    ':!tools/ci/check-negative-space.sh' \
    2>/dev/null || true
)

if (( ${#found[@]} > 0 )); then
  echo "ERROR: rejected upstream artifacts were reintroduced:"
  printf '  %s\n' "${found[@]}"
  exit 1
fi

printf 'Negative-space guard passed.\n'
