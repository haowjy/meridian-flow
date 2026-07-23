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

# DocumentMutationPolicy is a capability, not a convention. Check its narrow
# export/import/call boundary rather than exempting every line in large files.
mutation_policy_callers=(
  "apps/server/server/domains/collab/adapters/drizzle-branches.ts"
  "apps/server/server/domains/collab/composition.ts"
  "apps/server/server/domains/collab/domain/branch-coordinator.ts"
  "apps/server/server/domains/collab/domain/markdown-document.ts"
  "apps/server/server/domains/collab/hocuspocus-persistence.ts"
)

is_mutation_policy_caller() {
  local candidate="$1"
  local allowed
  for allowed in "${mutation_policy_callers[@]}"; do
    [[ "$candidate" == "$allowed" ]] && return 0
  done
  return 1
}

mutation_policy_violations=()
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  if ! is_mutation_policy_caller "$file"; then
    mutation_policy_violations+=("$file")
  fi
done < <(
  git grep -l -F 'createDocumentMutationPolicy' \
    -- 'apps/server/server/domains/collab/*.ts' \
    'apps/server/server/domains/collab/**/*.ts' \
    ':!apps/server/server/domains/collab/domain/document-mutation-policy.ts' \
    ':!**/*.test.ts' ':!**/*.db.test.ts' ':!**/test-support/**' ':!**/__conformance__/**' \
    2>/dev/null || true
)

mutation_policy_exports="$(git grep -l -E 'export function createDocumentMutationPolicy' -- \
  'apps/server/server/domains/collab/*.ts' \
  'apps/server/server/domains/collab/**/*.ts' \
  ':!**/*.test.ts' 2>/dev/null || true)"
expected_mutation_policy_export='apps/server/server/domains/collab/domain/document-mutation-policy.ts'
if [[ "$mutation_policy_exports" != "$expected_mutation_policy_export" ]]; then
  mutation_policy_violations+=("DocumentMutationPolicy must have one canonical production export: $mutation_policy_exports")
fi

# These permissive historical heuristics are forbidden specifically in the
# settlement/provenance safety core. Presentation and navigation code may still
# use text comparison or RelativePosition for their unrelated jobs.
forbidden_safety_fallbacks=()
while IFS= read -r hit; do
  [[ -n "$hit" ]] && forbidden_safety_fallbacks+=("$hit")
done < <(
  git grep -n -E \
    'blockOwner|block_owner|lastEditor|last_editor|Item\.redone|Y\.Snapshot|RelativePosition|diff-match-patch|diff_match_patch|textEquality|text_equality|textSimilarity|text_similarity' \
    -- \
    'apps/server/server/domains/collab/domain/document-mutation-policy.ts' \
    'apps/server/server/domains/collab/domain/branch-push-transition.ts' \
    'apps/server/server/domains/collab/domain/provenance.ts' \
    'apps/server/server/domains/collab/adapters/drizzle-provenance.ts' \
    2>/dev/null || true
)

if (( ${#mutation_policy_violations[@]} > 0 )); then
  echo "ERROR: content mutation bypasses DocumentMutationPolicy capability:"
  printf '  %s\n' "${mutation_policy_violations[@]}"
  exit 1
fi

if (( ${#forbidden_safety_fallbacks[@]} > 0 )); then
  echo "ERROR: forbidden semantic fallback entered the settlement/provenance safety core:"
  printf '  %s\n' "${forbidden_safety_fallbacks[@]}"
  exit 1
fi

printf 'Negative-space guard passed.\n'
