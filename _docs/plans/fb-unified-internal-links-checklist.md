---
detail: comprehensive
audience: developer
---

# Unified Internal Links Refactor Checklist

Status: Ready for implementation
Owner: Frontend
Scope: Document editor + shared reference plumbing used by composer/edit-turn surfaces

## Goal

Render internal markdown links (`[text](path.md)`) and wiki-links (`[[path|text]]`) with one consistent pill system, one resolver, and one classification policy, while reusing existing reference code paths and reducing duplication.

## Why This Is Better Than Before

Before:
- Internal markdown links are styled by `linkRenderer`, wiki-links by `wikiLinkScanner` with separate logic paths.
- Resolution and folder-path logic are duplicated across editor and thread reference search.
- `@` mention popover wiring is duplicated in `TurnInput`, `EditTurnInput`, and editor popover wrapper.
- DIP is weak in link rendering path due to direct concrete imports and scattered classification rules.

After:
- One shared reference domain (`core/references`) used by scanner, renderer, clipboard, and search.
- One internal-link classifier used everywhere that decides `internal/external/anchor/unsupported`.
- One pill-decoration builder for both syntaxes, preserving click/delete/broken-link behavior.
- Reduced duplicate UI plumbing for mention popovers and result mapping.
- Lower regression risk, easier future extension (`#tags`, embeds, block refs) via isolated interfaces.

## Guardrails

- Keep existing behavior unless explicitly listed as an intentional change.
- Prefer extracting reusable pure utilities over adding feature-local helpers.
- Preserve O(viewport) decoration work; do not scan full docs unnecessarily.
- Do not break existing wiki-link click/delete/clipboard behavior.

## Phase 0: Baseline + Safety

- [ ] Snapshot current behavior with targeted tests before refactor.
- [ ] Add "no behavior change" assertions for wiki-link click attributes and broken-link style.

Files to touch:

| File | Where | Change | Why |
|---|---|---|---|
| `frontend/tests/wikiLinkRegex.test.ts` | New/updated test cases | Add baselines for display range, whitespace alias handling, multiline rejection | Prevent parser regressions while refactoring shared parsing/decorations |
| `frontend/tests/wikiLinkClipboardInterop.test.ts` | New/updated test cases | Add explicit doc/folder path roundtrip assertions | Protect clipboard contract through resolver extraction |

## Phase 1: Extract Shared Reference Domain

- [ ] Create shared types + interfaces.
- [ ] Extract folder path building and reference resolution to pure functions.
- [ ] Keep thin adapter for store-backed resolution.

Files to add:

| File | Purpose |
|---|---|
| `frontend/src/core/references/types.ts` | `ReferenceType`, `ResolvedReference`, resolver input/output contracts |
| `frontend/src/core/references/pathing.ts` | Folder path helpers (`buildFolderPath`, lookup maps) |
| `frontend/src/core/references/resolve.ts` | Pure resolver from tree snapshot (`documents`, `folders`) |
| `frontend/src/core/references/classifyLinkTarget.ts` | Internal link classification policy |
| `frontend/src/core/references/index.ts` | Public exports |

Files to modify:

| File | Where | Change | Why |
|---|---|---|---|
| `frontend/src/core/editor/codemirror/wikiLinks/resolveDocument.ts` | Whole file | Delegate to `core/references/resolve.ts`; keep compatibility exports | Single source of truth for resolution logic |
| `frontend/src/features/threads/components/documentReferenceSearch.ts` | Folder path helper section | Replace local `buildFolderPath` with shared pathing utility | Remove duplicated folder hierarchy logic |
| `frontend/src/core/editor/codemirror/wikiLinks/index.ts` | Exports block | Re-export types from shared reference module as needed | Keep imports stable while consolidating internals |

## Phase 2: Unify Pill Decoration Contract

- [ ] Create one builder for mark/replace decorations + data attributes.
- [ ] Move attribute schema into a shared contract comment/type.
- [ ] Refactor wiki-link scanner to use builder, no behavior change.

Files to add:

| File | Purpose |
|---|---|
| `frontend/src/core/editor/codemirror/internalLinks/pillDecorations.ts` | Shared decoration builder for internal references |
| `frontend/src/core/editor/codemirror/internalLinks/types.ts` | Parsed link span + decoration input contracts |
| `frontend/src/core/editor/codemirror/internalLinks/index.ts` | Exports for internal-link tooling |

Files to modify:

| File | Where | Change | Why |
|---|---|---|---|
| `frontend/src/core/editor/codemirror/wikiLinks/wikiLinkScanner.ts` | Decoration construction loop | Replace inline decoration code with shared builder calls | Eliminate duplicate rendering logic and keep click contract centralized |
| `frontend/src/core/editor/codemirror/wikiLinks/wikiLinkPlugin.ts` | Selector + dataset reads | Validate/align to shared data-attribute contract | Keep interaction behavior consistent after scanner refactor |

Contract to preserve:
- `data-doc-path`
- `data-display-name`
- `data-link-from`
- `data-link-to`
- `data-ref-id`
- `data-ref-type`
- `data-doc-id` (backward compatibility)

## Phase 3: Render Markdown Internal Links via Syntax Tree (Not Regex)

- [ ] Upgrade link renderer to classify link targets and route internal links to pill builder.
- [ ] Keep external links in existing blue-link behavior.
- [ ] Exclude anchors/fragments-only links from internal pill rendering.

Files to modify:

| File | Where | Change | Why |
|---|---|---|---|
| `frontend/src/core/editor/codemirror/livePreview/renderers/link.ts` | `render()` | Parse `Link` node boundaries/URL child; classify target; for internal build pill via shared builder | Correctness on markdown edge cases; no regex drift |
| `frontend/src/core/editor/codemirror/livePreview/renderers/index.ts` | registration section | Keep single `linkRenderer`; do not add competing markdown scanner | Avoid double rendering and responsibility overlap |
| `frontend/src/core/editor/codemirror/livePreview/cursorUtils.ts` | optional helper additions | Add tiny helper for "cursor inside range" if needed by shared builder | Reuse consistent reveal behavior |

## Phase 4: Reuse @-Reference Plumbing Across Surfaces

- [ ] Extract shared hook for floating mention anchor + lifecycle.
- [ ] Extract shared mapper `MentionResult -> ReferenceElementData`.
- [ ] Replace duplicated logic in turn input and edit-turn input.

Files to add:

| File | Purpose |
|---|---|
| `frontend/src/features/threads/composer/useMentionPopoverAnchor.ts` | Shared floating anchor management for mention popovers |
| `frontend/src/features/threads/composer/referenceMappers.ts` | Mapper utilities for mention selection and pending refs |

Files to modify:

| File | Where | Change | Why |
|---|---|---|---|
| `frontend/src/features/threads/components/TurnInput.tsx` | mention anchor + selection handlers | Replace duplicate anchor/mapping code with shared hook + mapper | Reduce UI duplication and drift |
| `frontend/src/features/threads/components/EditTurnInput.tsx` | mention anchor + selection handlers | Same as above | Keep behaviors aligned between composer contexts |
| `frontend/src/features/documents/components/EditorWikiLinkPopover.tsx` | floating setup | Reuse shared anchor/floating logic where practical | Consistent popover behavior and fewer one-off variants |
| `frontend/src/features/documents/components/EditorPanel.tsx` | mention select callback | Use shared mapper/utilities for wiki-link insertion inputs | Consistent reference data shaping |

Optional cleanup (if safe this pass):
- Move `atDetection.ts` from composer-specific folder to a shared editor location.

## Phase 5: Tests for New Shared Contracts

- [ ] Add tests for classifier policy.
- [ ] Add tests for pure resolver.
- [ ] Add tests for markdown-internal rendering decision points.
- [ ] Confirm no regressions in wiki-link scanner behavior.

Files to add:

| File | Focus |
|---|---|
| `frontend/tests/linkTargetClassifier.test.ts` | `internal/external/anchor/unsupported` classification cases |
| `frontend/tests/referenceResolver.test.ts` | exact path, unique filename, folder fallback, ambiguous behavior |

Files to modify:

| File | Where | Change | Why |
|---|---|---|---|
| `frontend/tests/wikiLinkRegex.test.ts` | add compatibility assertions | Ensure scanner parser behavior unchanged while internals move |
| `frontend/tests/wikiLinkClipboardInterop.test.ts` | add folder + path-by-id assertions | Preserve clipboard behavior through resolver extraction |

## Phase 6: Documentation + Final Consistency Pass

- [ ] Update feature docs for unified internal-link rendering and shared resolver/classifier.
- [ ] Mention that markdown internal links now share pill behavior with wiki-links.
- [ ] Run markdown link checker.

Files to modify:

| File | Change |
|---|---|
| `_docs/features/f-document-editor/README.md` | Update "Wiki-Link References" to include markdown internal link pill parity |
| `_docs/features/f-document-editor/rich-text-features.md` | Add concise note on unified internal link rendering behavior |
| `_docs/plans/fb-wikilinks-and-internal-links.md` | Add pointer to this checklist as implementation plan refinement |

## Execution Checklist (Ordered)

- [ ] Phase 0 complete
- [ ] Phase 1 complete
- [ ] Phase 2 complete
- [ ] Phase 3 complete
- [ ] Phase 4 complete
- [ ] Phase 5 complete
- [ ] Phase 6 complete
- [ ] `pnpm run lint` passes
- [ ] Targeted tests pass
- [ ] `./scripts/check-md-links.sh` passes

## Acceptance Criteria

- [ ] `[text](internal/path.md)` renders with same pill style and behavior as `[[internal/path|text]]`.
- [ ] `[text](https://...)` remains external link styling.
- [ ] `[#heading](#heading)` is not treated as internal doc reference.
- [ ] Clicking internal pills preserves document/folder navigation behavior.
- [ ] Broken internal references preserve dashed/broken styling.
- [ ] Cursor-reveal behavior remains consistent for both syntaxes.
- [ ] Diff excluded regions suppress both wiki-link and markdown-pill decorations.

## Rollback Plan

- Keep old wiki-link scanner behavior available behind minimal revert commit.
- Land phases in small PRs to isolate regressions:
  1. Shared domain extraction
  2. Shared pill builder
  3. Link renderer integration
  4. Mention plumbing dedupe

