#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel)"
cd "$ROOT_DIR"

forbidden_paths=(
  "apps/server/server/domains/sandbox"
  "apps/server/server/lib/sandbox-runtime-factory.ts"
  "apps/server/server/domains/context/adapters/sandbox-aware-fs"
  "apps/server/server/domains/context/promotion"
  "apps/server/server/domains/figures"
  "apps/server/server/domains/input-ingest"
  "apps/app/src/features/editor/figure-workflow.ts"
  "apps/app/src/features/editor/figure"
  "contracts/openapi"
  "contracts/asyncapi"
  "contracts/jsonschema"
  "contracts/fixtures"
)

violations=()
for path in "${forbidden_paths[@]}"; do
  if [[ -e "$path" ]]; then
    violations+=("forbidden path: $path")
  fi
done

scan_roots=(apps packages)
for pattern in \
  "markdown-replace" \
  "@workos" \
  "workos" \
  "SandboxProvider" \
  "SandboxScope" \
  "SandboxAwareFS" \
  "sandbox_preview" \
  "skill-tool-factory" \
  "stageSkillFiles" \
  "ensureUvProjectsSynced" \
  "math_display" \
  "VolumaFigure" \
  "FigureNodeView" \
  "@tiptap/extension-mathematics" \
  "@tiptap/extension-table" \
  "code-block-lowlight" \
  "lowlight" \
  "highlight.js"; do
  while IFS= read -r hit; do
    violations+=("forbidden token '$pattern': $hit")
  done < <(rg -n --glob '!**/node_modules/**' --glob '!**/.output/**' --glob '!**/*.md' --glob '!**/*.spec.ts' --glob '!**/*.test.ts' "$pattern" "${scan_roots[@]}" || true)
done

if (( ${#violations[@]} > 0 )); then
  echo "ERROR: rejected Voluma/scientific/sandbox artifacts were reintroduced:"
  for violation in "${violations[@]}"; do
    echo "  - $violation"
  done
  exit 1
fi

echo "Negative-space guard passed."
