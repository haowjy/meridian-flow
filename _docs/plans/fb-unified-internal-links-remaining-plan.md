---
detail: comprehensive
audience: developer
---

# Unified Internal Links: Remaining Work Plan (Re-reviewed)

Status: Drafted after implementation audit  
Scope: Frontend only (`core/references`, CodeMirror live preview, thread composer/edit mention UX)

## Re-review Summary

Implemented already:
- Shared reference module exists: `frontend/src/core/references/*`
- Markdown link classification exists and is integrated in live preview
- Thread reference search reuses shared `buildFolderPath`
- Baseline classifier and wiki-link tests exist

Remaining gaps:
- Markdown renderer still parses links by string slicing (`indexOf("](")`) instead of syntax-node children
- Resolver API is still store-coupled (`useTreeStore.getState()` inside resolver functions)
- Mention popover wiring is duplicated between:
  - `frontend/src/features/threads/components/TurnInput.tsx`
  - `frontend/src/features/threads/components/EditTurnInput.tsx`
- Resolver-focused tests are missing
- Feature docs do not mention markdown-internal-link pill parity

## Core Behavior Contract

- Markdown links (`[text](target)`) are dual-mode:
  - Internal when target resolves to project document/folder
  - External when target is URL or unresolved path
- Wiki-links (`[[target|alias]]`) are internal-reference syntax only:
  - Resolved wiki-links render as normal internal pills
  - Unresolved wiki-links remain internal-intent and render broken-pill state (not external link widgets)

## Decision: Do We Need a Shared Internal-Link Pill Builder?

Short answer: **not as a required refactor**.

Reasoning:
- The wiki-link and markdown-link renderers are structurally similar, but they differ in important behavior:
  - Parsing source differs (regex scan vs Lezer syntax tree)
  - Unresolved wiki-links show broken-pill state; markdown unresolved links intentionally degrade to external links
  - Cursor reveal conditions differ slightly by mode
- Forcing one full shared builder now risks over-abstraction and can reduce clarity.

Recommended compromise:
- Keep separate scanner/renderer implementations.
- Share only small, stable primitives if needed later (attribute/class assembly helper), not full decoration orchestration.

This keeps SRP/OCP stronger than a premature "unify everything" abstraction.

## Recommended Plan (Lean, High-Value)

### Phase 1: Fix Markdown Link Parsing Robustness (Required)

Goal:
- Remove string slicing in link renderer and parse from syntax children (`URL`, `LinkMark`) to avoid markdown edge-case drift.

Files:
- `frontend/src/core/editor/codemirror/livePreview/renderers/link.ts`

Changes:
- In `render()`, derive link text range and URL range from `node.getChild(...)` / child traversal.
- Keep existing behavior matrix (`internal` pill, `external` widget, `anchor/unsupported` simple style).
- Preserve current data attributes for internal links:
  - `data-doc-path`, `data-display-name`, `data-link-from`, `data-link-to`, `data-ref-id`, `data-ref-type`, `data-doc-id` (doc only)

Why this is better:
- Correctness comes from parser structure, not fragile text assumptions.
- Better extensibility for future markdown link forms.

Acceptance:
- No behavior change for existing happy-path links.
- Existing `classifyLinkTarget` tests still pass.

### Phase 2: Introduce Pure Resolver + Store Adapter (Required)

Goal:
- Make resolution logic testable and dependency-inverted.

Files:
- `frontend/src/core/references/resolve.ts`
- `frontend/src/core/references/index.ts`
- `frontend/src/core/editor/codemirror/wikiLinks/resolveDocument.ts` (compat exports only if needed)

Changes:
- Extract pure functions:
  - `resolveReferenceFromTree(path, { documents, folders })`
  - `resolveDocumentPathByIdFromTree(id, { documents })`
  - `resolvePathByIdFromTree(id, { documents, folders })`
- Keep existing store-backed wrappers (`resolveReference`, etc.) for call-site compatibility.

Why this is better:
- DIP: domain logic no longer depends directly on global store internals.
- Cleaner unit tests and lower coupling.

Acceptance:
- Existing call sites unchanged.
- New pure-path tests pass (see Phase 4).

### Phase 3: Extract Shared Mention Utilities for Thread Inputs (Required)

Goal:
- Remove duplicated mention selection mapping and floating anchor wiring in thread composer surfaces.

Files to add:
- `frontend/src/features/threads/composer/referenceMappers.ts`
- `frontend/src/features/threads/composer/useMentionPopoverAnchor.ts`

Files to modify:
- `frontend/src/features/threads/components/TurnInput.tsx`
- `frontend/src/features/threads/components/EditTurnInput.tsx`

Changes:
- `referenceMappers.ts`: add `mentionResultToReferenceElementData(result)` mapper.
- `useMentionPopoverAnchor.ts`: encapsulate floating setup + anchor coordinate tracking for `AtMentionState`.
- Replace duplicated local logic in both components with hook + mapper.

Why this is better:
- Consistency and reduced drift between compose/edit flows.
- Helps SRP, especially `TurnInput.tsx` (already >500 lines).

Acceptance:
- Mention UX and keyboard behavior unchanged.
- Both components keep identical mapping rules for selected mentions.

### Phase 4: Add Missing Resolver Tests (Required)

Files to add:
- `frontend/tests/referenceResolver.test.ts`

Test matrix:
- Document exact path resolution
- Unique filename fallback
- Ambiguous filename returns null
- Folder exact path resolution
- Unique folder name fallback
- `resolvePathById` for document + folder
- Missing IDs return null

Why this is better:
- Protects resolver behavior through future refactors.

### Phase 5: Update Feature Docs (Required)

Files to modify:
- `_docs/features/f-document-editor/README.md`
- `_docs/features/f-document-editor/rich-text-features.md`

Changes:
- Document that markdown internal links (`[text](path.md)`) and wiki-links share pill rendering behavior for resolved internal targets.
- Keep wording concise and behavior-focused.

Acceptance:
- `./scripts/check-md-links.sh` passes.

## Optional Plan (Only If We See Drift Later)

### Optional A: Shared Pill Metadata Helper (Not full builder)

Trigger:
- Do this only if class/attribute assembly diverges across scanner/renderer again.

Potential file:
- `frontend/src/core/editor/codemirror/internalLinks/pillMetadata.ts`

Shared scope only:
- Build mark classes from `{ isBroken, isFolder }`
- Build common data attributes from `{ path, displayName, range, resolved }`

Avoid sharing:
- Syntax-range construction
- Cursor reveal logic
- Parser-specific branching

## Ordered Execution Checklist

- [ ] Phase 1 complete
- [ ] Phase 2 complete
- [ ] Phase 3 complete
- [ ] Phase 4 complete
- [ ] Phase 5 complete
- [ ] `pnpm run lint` passes
- [ ] Targeted tests pass (`pnpm vitest run ...`)
- [ ] `./scripts/check-md-links.sh` passes
