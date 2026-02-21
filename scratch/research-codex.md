# Research Notes — Yjs/CM6 Changeset-Based Diff Rendering

## Problem Statement
We want to render AI proposal diffs from the actual Yjs edit operations (proposal `yjs_update`) instead of deriving `baseText`/`proposedText` and running a string diff.

Key question: can we extract structured, position-aware edits (insert/delete/retain) directly and drive UI from those operations.

## Codebase Context
Current Meridian review path is text-based:

- `packages/cm6-collab/src/review/runtime.ts:24` derives review from proposal update by:
  - reading current text (`baseText`)
  - cloning doc (`cloneDoc`)
  - `Y.applyUpdate(nextDoc, update)`
  - reading `proposedText`
- `packages/cm6-collab/src/review/merge.ts:38` mounts `@codemirror/merge` with `{a: baseText, b: proposedText}`.
- `frontend/src/features/documents/components/AIProposalReviewDiff.tsx:40` renders this merge view.

So today the operation stream is collapsed into two strings before rendering.

Relevant existing pattern in ecosystem (already in dependency):

- `y-codemirror.next` maps `YTextEvent.delta` directly to CodeMirror changes:
  - `frontend/node_modules/.pnpm/y-codemirror.next.../src/y-sync.js:107`
  - uses `retain` to advance position, `delete` for removal ranges, `insert` for inserted text.

Backend proposal update production:

- `backend/internal/service/collab/yjs_text_converter.go:26` creates relative updates using `EncodeStateAsUpdate(targetDoc, baseStateVector)`.

## Best Practices
### Findings from docs/source
1. Yjs update APIs are sync/transport oriented, not human diff APIs.
- `Y.diffUpdate` computes missing sync bytes vs state vector, not text edit hunks.
- Source: https://docs.yjs.dev/api/document-updates

2. Yjs has update introspection, but it is low-level.
- `decodeUpdate` is exported and returns `{ structs, ds }` (internal `Item/GC/Skip` + delete set):
  - `frontend/node_modules/.pnpm/yjs@13.6.29/node_modules/yjs/src/utils/updates.js:139`
- This is CRDT-struct-level, not linear editor offsets.

3. Yjs operation-level, position-aware changes for text are exposed through `YTextEvent.delta`.
- `yevent.changes.delta` / `ytextEvent.delta` documented in Y.Event docs.
- Delta format is retain/insert/delete (Quill-style) for sequence changes.
- Sources:
  - https://docs.yjs.dev/api/y.event
  - https://docs.yjs.dev/api/delta-format
  - `frontend/node_modules/.pnpm/yjs@13.6.29/node_modules/yjs/src/types/YText.js:655`

4. CodeMirror `ChangeSet` is an edit-operations model and can be built directly from structured changes.
- `ChangeSet.of(...)`, `iterChanges(...)`:
  - `frontend/node_modules/.pnpm/@codemirror+state@6.5.2/node_modules/@codemirror/state/dist/index.d.ts:273`

5. `@codemirror/merge` does not accept a `ChangeSet`/chunks as primary input.
- Split and unified views are doc-to-doc APIs.
- It allows `diffConfig.override` returning `Change[]`, but merge still runs presentational normalization.
- Sources:
  - `frontend/node_modules/.pnpm/@codemirror+merge@6.12.0/node_modules/@codemirror/merge/dist/index.d.ts:50`
  - `frontend/node_modules/.pnpm/@codemirror+merge@6.12.0/node_modules/@codemirror/merge/dist/index.d.ts:201`

6. VS Code Copilot edit review model is operation-first in workflow.
- Edits are applied, then reviewed as inline change chunks with keep/undo.
- Source: https://code.visualstudio.com/docs/copilot/chat/review-code-edits

### Practical note from local verification
I ran a local Node probe against `yjs@13.6.29`:

- `decodeUpdate(update)` returns `structs` + `DeleteSet` (client clocks), not direct linear text positions.
- Applying the proposal update on a clone and observing Y.Text yields exact delta, e.g.:
  - `[{ retain: 6 }, { delete: 6 }, { insert: "new " }]`

This confirms the right extraction surface is `Y.Text` observe-event delta, not raw decoded structs.

## Alternative Approaches
### Approach A: Decode update bytes (`decodeUpdate`) and reconstruct text edits from structs
Implementation idea:
- Parse `Y.decodeUpdate(update)`
- Walk `Item`/`GC`/`DeleteSet`
- Reconstruct offsets and deleted text

Pros:
- Operates on raw update bytes
- No doc apply step

Cons:
- Struct model is internal CRDT representation (client clocks/origins), not ready-to-render offsets
- Need to re-implement Yjs integration logic to map structs into linear text coordinates safely
- Fragile to Yjs internals/version differences

Codebase fit: Poor. Too complex and high maintenance for current frontend architecture.

### Approach B: Apply update on cloned doc, capture `YTextEvent.delta`, convert to structured ops/`ChangeSet`
Implementation idea:
- Clone current `Y.Doc` (already done today)
- Attach `ytext.observe` listener
- `Y.applyUpdate(clone, proposalUpdate, originTag)`
- Read `event.delta`
- Convert delta to `EditOp[]` and/or CodeMirror `ChangeSet`

Pros:
- Uses canonical Yjs API for text changes
- Preserves the actual operation sequence (retain/delete/insert)
- Matches proven `y-codemirror.next` mapping strategy
- No text diff algorithm required

Cons:
- Still needs apply-to-clone (but this is already in current pipeline)
- Deleted text must be recovered from base text slices using delta cursor
- If proposal touches multiple shared types, need type filtering

Codebase fit: Excellent. Minimal conceptual change from existing runtime.

### Approach C: Keep `@codemirror/merge`, inject op-derived `Change[]` via `diffConfig.override`
Implementation idea:
- Build changes from Approach B ops
- Provide custom `diffConfig.override(a, b) => Change[]`

Pros:
- Reuses existing merge view UI
- Low migration risk

Cons:
- `@codemirror/merge` still performs presentational cleanup (`presentableDiff` path), so output may not be exact operation boundaries
- Merge API still fundamentally doc-to-doc
- Not a pure "render exact ops" model

Codebase fit: Good as transitional step, not ideal if strict operation fidelity is required.

## Recommendation
Use **Approach B** as the canonical extraction path, and model proposal review around **operation payloads** (`retain/delete/insert`) rather than text diff.

Concretely for Meridian:

1. In proposal review runtime, add a new derivation path:
- `deriveProposalOperations(proposal) -> { baseText, ops, changeSet, proposedText? }`
- Build ops by observing `Y.Text` while applying proposal update to a clone.

2. Rendering strategy:
- Short term: keep current merge UI but feed op-derived `Change[]` through `diffConfig.override` (lowest-risk migration).
- Medium term (if exactness matters): move to an op-driven renderer (decorations/widgets) so UI reflects exact operation boundaries without merge normalization.

Why this is best for this codebase:
- Reuses current clone/apply architecture (`review/runtime.ts`)
- Aligns with installed ecosystem binding behavior (`y-codemirror.next`)
- Avoids fragile CRDT-internal parsing and avoids text diff compute
- Preserves future ability to keep full audit semantics of proposal operations

## Open Questions
1. Is “exact operation fidelity” required in UI, or is a presentation-normalized view acceptable?
2. Do we need multi-type support beyond `Y.Text("content")` for proposal rendering?
3. Should operation payloads be persisted/serialized for later replay, or derived on demand from `yjs_update`?
4. Are proposal updates guaranteed to be single-transaction text edits, or can one proposal emit multiple text events/chunks?

## Sources
- Yjs Document Updates: https://docs.yjs.dev/api/document-updates
- Yjs Y.Event: https://docs.yjs.dev/api/y.event
- Yjs Delta Format: https://docs.yjs.dev/api/delta-format
- Yjs source (`decodeUpdate`): https://github.com/yjs/yjs/blob/main/src/utils/updates.js
- CodeMirror Reference: https://codemirror.net/docs/ref/
- VS Code edit review flow: https://code.visualstudio.com/docs/copilot/chat/review-code-edits
- y-codemirror.next package: https://www.npmjs.com/package/y-codemirror.next
- Yjs update inspection tooling mention: https://yjs.dev/yjs-inspector/
- Y-Sweet debugger (update inspector): https://www.npmjs.com/package/@y-sweet/debugger
- Yjs discussion (update decoding): https://discuss.yjs.dev/t/decypher-encoding-update/1773
