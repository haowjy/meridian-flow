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

# Content mutation operations are explicit capabilities. The old sum-interface,
# fake source-cut lookup, and unsupported arms must not return.
mutation_policy_violations=()
while IFS= read -r hit; do
  [[ -n "$hit" ]] && mutation_policy_violations+=("$hit")
done < <(
  git grep -n -E \
    'createDocumentMutationPolicy|DocumentMutationPolicyPort|sourceCutId|unsupportedMutationPolicyOperation|stagePush|completePush' \
    -- \
    'apps/server/server/domains/collab/*.ts' \
    'apps/server/server/domains/collab/**/*.ts' \
    'apps/server/scripts/*.ts' \
    ':!**/*.test.ts' ':!**/*.db.test.ts' ':!**/test-support/**' ':!**/__conformance__/**' \
    2>/dev/null || true
)

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
  echo "ERROR: obsolete document-mutation capability sediment returned:"
  printf '  %s\n' "${mutation_policy_violations[@]}"
  exit 1
fi

report_only_sediment=()
while IFS= read -r hit; do
  [[ -n "$hit" ]] && report_only_sediment+=("$hit")
done < <(
  git grep -n -E \
    'undoAccept|undoReject|countInFlightDraftSessionsByWork|collab\.safety_notices' \
    -- \
    'apps/server/server/domains/collab/*.ts' \
    'apps/server/server/domains/collab/**/*.ts' \
    ':!**/*.test.ts' ':!**/*.db.test.ts' ':!**/test-support/**' ':!**/__conformance__/**' \
    2>/dev/null || true
)
while IFS= read -r hit; do
  [[ -n "$hit" ]] && report_only_sediment+=("$hit")
done < <(
  git grep -n -E \
    'historicalBodySchema|canonicalBlockIdentityV1Schema|navigationTargetV1Schema|changeTrailShellV1Schema' \
    -- 'packages/contracts/src/**/*.ts' 2>/dev/null || true
)
while IFS= read -r hit; do
  [[ -n "$hit" ]] && report_only_sediment+=("$hit")
done < <(
  git grep -n -E \
    '@meridian/database|from "drizzle-orm"|shared/drizzle-transaction|observability/index|/adapters/' \
    -- \
    'apps/server/server/domains/collab/domain/*.ts' \
    'apps/server/server/domains/collab/domain/**/*.ts' \
    ':!**/*.test.ts' ':!**/*.db.test.ts' ':!**/__fixtures__/**' \
    2>/dev/null || true
)

latest_database_snapshot="$(printf '%s\n' packages/database/src/migrations/meta/*_snapshot.json | sort -V | tail -n 1)"
while IFS= read -r hit; do
  [[ -n "$hit" ]] && report_only_sediment+=("$latest_database_snapshot:$hit")
done < <(
  grep -n -E \
    'public\.model_response_(causal_cuts|observation_entries|observation_snapshots)|"lineage_evidence"' \
    "$latest_database_snapshot" 2>/dev/null || true
)

if (( ${#report_only_sediment[@]} > 0 )); then
  echo "ERROR: report-only pivot sediment returned:"
  printf '  %s\n' "${report_only_sediment[@]}"
  exit 1
fi

if (( ${#forbidden_safety_fallbacks[@]} > 0 )); then
  echo "ERROR: forbidden semantic fallback entered the settlement/provenance safety core:"
  printf '  %s\n' "${forbidden_safety_fallbacks[@]}"
  exit 1
fi

printf 'Negative-space guard passed.\n'
