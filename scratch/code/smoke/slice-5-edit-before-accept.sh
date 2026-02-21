#!/usr/bin/env bash
set -euo pipefail

echo "Checking edited partial-apply API..."
rg -n "export function buildEditedChunkUpdate" \
  packages/cm6-collab/src/review/partial-apply.ts >/dev/null

echo "Checking unified review edit callback wiring..."
rg -n "onEditChunk\\?: \\(chunk: ReviewChunk\\) => void" \
  packages/cm6-collab/src/review/unified-review.ts >/dev/null
rg -n "editBtn\\.textContent = \"Edit\"" \
  packages/cm6-collab/src/review/unified-review.ts >/dev/null

echo "Checking frontend Save & Accept flow..."
rg -n "Save & Accept" \
  frontend/src/features/documents/components/AIProposalReviewPanel.tsx >/dev/null
rg -n "accepted_with_edits" \
  frontend/src/features/documents/components/AIProposalReviewPanel.tsx >/dev/null
rg -n "applyChunkUpdate: \\(chunk: ReviewChunk, editedInsertedText\\?: string\\) => void" \
  frontend/src/features/documents/hooks/useDocumentCollab.ts >/dev/null

echo "slice-5-edit-before-accept smoke checks passed."
