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

# DocumentAuthority is a capability, not a convention. Check its narrow
# export/import/call boundary rather than exempting every line in large files.
authority_callers=(
  "apps/server/server/domains/collab/adapters/drizzle-branches.ts"
  "apps/server/server/domains/collab/composition.ts"
  "apps/server/server/domains/collab/domain/branch-coordinator.ts"
  "apps/server/server/domains/collab/domain/markdown-document.ts"
  "apps/server/server/domains/collab/hocuspocus-persistence.ts"
)

is_authority_caller() {
  local candidate="$1"
  local allowed
  for allowed in "${authority_callers[@]}"; do
    [[ "$candidate" == "$allowed" ]] && return 0
  done
  return 1
}

authority_violations=()
while IFS=: read -r file line rest; do
  [[ -z "$file" ]] && continue
  if ! is_authority_caller "$file"; then
    authority_violations+=("$file:$line:$rest")
  fi
done < <(
  git grep -n -E '(import .*createDocumentAuthority|createDocumentAuthority\()' \
    -- 'apps/server/server/domains/collab/**/*.ts' \
    ':!apps/server/server/domains/collab/domain/document-authority.ts' \
    ':!**/*.test.ts' ':!**/*.db.test.ts' ':!**/test-support/**' ':!**/__conformance__/**' \
    2>/dev/null || true
)

authority_exports="$(git grep -l -E 'export function createDocumentAuthority' -- \
  'apps/server/server/domains/collab/**/*.ts' ':!**/*.test.ts' 2>/dev/null || true)"
expected_authority_export='apps/server/server/domains/collab/domain/document-authority.ts'
if [[ "$authority_exports" != "$expected_authority_export" ]]; then
  authority_violations+=("DocumentAuthority must have one canonical production export: $authority_exports")
fi

# These permissive historical heuristics are forbidden specifically in the
# settlement/provenance authority. Presentation and navigation code may still
# use text comparison or RelativePosition for their unrelated jobs.
forbidden_authority_fallbacks=()
while IFS= read -r hit; do
  [[ -n "$hit" ]] && forbidden_authority_fallbacks+=("$hit")
done < <(
  git grep -n -E \
    'blockOwner|block_owner|lastEditor|last_editor|Item\.redone|Y\.Snapshot|RelativePosition|diff-match-patch|diff_match_patch|textEquality|text_equality|textSimilarity|text_similarity' \
    -- \
    'apps/server/server/domains/collab/domain/document-authority.ts' \
    'apps/server/server/domains/collab/domain/branch-push-transition.ts' \
    'apps/server/server/domains/collab/domain/provenance.ts' \
    'apps/server/server/domains/collab/adapters/drizzle-provenance.ts' \
    2>/dev/null || true
)

if (( ${#authority_violations[@]} > 0 )); then
  echo "ERROR: content mutation bypasses DocumentAuthority capability:"
  printf '  %s\n' "${authority_violations[@]}"
  exit 1
fi

if (( ${#forbidden_authority_fallbacks[@]} > 0 )); then
  echo "ERROR: forbidden semantic fallback entered settlement/provenance authority:"
  printf '  %s\n' "${forbidden_authority_fallbacks[@]}"
  exit 1
fi

printf 'Negative-space guard passed.\n'
