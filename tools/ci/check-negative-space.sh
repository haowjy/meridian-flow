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

# DocumentAuthority is a capability, not a convention. Production modules that
# journal content or apply bytes to a named mutable authority must either be the
# aggregate or one of its audited adapters. Scratch/reconstruction Y.Docs are
# intentionally outside this check.
authority_adapters=(
  "apps/server/server/domains/collab/domain/document-authority.ts"
  "apps/server/server/domains/collab/domain/branch-coordinator.ts"
  "apps/server/server/domains/collab/domain/markdown-document.ts"
  # These two only materialize scratch Y.Docs despite their local liveDoc names.
  "apps/server/server/domains/collab/domain/branch-agent-edit.ts"
  "apps/server/server/domains/collab/domain/branch-push-executor.ts"
  # Discard commits state + review rows atomically behind the branch-store adapter.
  "apps/server/server/domains/collab/domain/branch-review-operations.ts"
  "apps/server/server/domains/collab/hocuspocus-persistence.ts"
  "apps/server/server/domains/collab/adapters/drizzle-branches.ts"
  "apps/server/server/domains/collab/adapters/drizzle-journal.ts"
  "apps/server/server/domains/collab/adapters/drizzle-trail-forward-actions.ts"
  # A4.2 J4: BranchPushTransition replaces this temporary settlement adapter.
  "apps/server/server/domains/collab/domain/branch-push-settlement.ts"
)

is_authority_adapter() {
  local candidate="$1"
  local allowed
  for allowed in "${authority_adapters[@]}"; do
    [[ "$candidate" == "$allowed" ]] && return 0
  done
  return 1
}

authority_violations=()
while IFS=: read -r file line rest; do
  [[ -z "$file" ]] && continue
  if ! is_authority_adapter "$file"; then
    authority_violations+=("$file:$line:$rest")
  fi
done < <(
  git grep -n -E \
    '(journal\.(append|appendBatch|appendWriterUpdate)|Y\.applyUpdate\((liveDoc|branchDoc|current\.doc))' \
    -- 'apps/server/server/domains/collab/**/*.ts' \
    ':!**/*.test.ts' ':!**/*.db.test.ts' ':!**/test-support/**' ':!**/__conformance__/**' \
    2>/dev/null || true
)

if (( ${#authority_violations[@]} > 0 )); then
  echo "ERROR: content mutation bypasses DocumentAuthority capability:"
  printf '  %s\n' "${authority_violations[@]}"
  exit 1
fi

printf 'Negative-space guard passed.\n'
