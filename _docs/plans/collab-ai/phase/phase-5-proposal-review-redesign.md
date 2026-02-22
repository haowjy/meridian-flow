# Phase 5: Proposal Review UI Redesign

## Problem

When `autoAcceptProposals` is OFF, the current review UI is a separate panel above the editor with a full side-by-side `@codemirror/merge` MergeView. This has several issues:

1. **Code-oriented diff** — `@codemirror/merge` uses character-level Myers diff, which is noisy for prose (e.g., rephrasing a sentence shows dozens of tiny char-level insertions/deletions)
2. **All-or-nothing** — Accept/reject is per-proposal only; no chunk-level granularity
3. **Out-of-context** — The diff panel is separate from the editor, forcing context-switching
4. **No inline mode** — Only side-by-side, no unified/inline view
5. **No editing** — Can't modify a suggestion before accepting

## Vision

Replace the current panel with an **inline unified diff** rendered directly in the editor using `@codemirror/merge`'s `unifiedMergeView`, with a writing-oriented chunk system and per-chunk accept/reject/edit controls.

```
┌─────────────────────────────────────────────────────┐
│ Editor                                    [⇔ Split] │
│                                                     │
│  The sun dipped below the horizon, painting the     │
│  sky in hues of amber and violet.                   │
│                                                     │
│  ┌─ Chunk 1 ──────────────── [✓ Accept] [✗ Reject]─┐│
│  │ - She walked slowly through the garden,          ││
│  │ + She drifted through the moonlit garden,        ││
│  └──────────────────────────────────────────────────┘│
│                                                     │
│  pausing to breathe in the jasmine-scented air.     │
│                                                     │
│  ┌─ Chunk 2 ──────────────── [✓ Accept] [✗ Reject]─┐│
│  │ - The old house stood silent and dark.            ││
│  │ + The old house loomed against the starless sky,  ││
│  │ + its windows like hollow eyes.                   ││
│  └──────────────────────────────────────────────────┘│
│                                                     │
│  ┌─────────────────────────────────────────────────┐ │
│  │ Proposal: "Enhance atmosphere" (2 chunks)       │ │
│  │ [Accept All] [Reject All]  [← Prev] [Next →]   │ │
│  └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### Key Design Decisions

1. **Changeset-driven, not diff-driven** — use the actual Yjs edit operations (retain/delete/insert) from the proposal update, NOT a text diff algorithm. The Yjs update already knows exactly what was changed.
2. **Unified (inline) diff by default** — single editor pane with deletions/insertions inline, toggle to side-by-side
3. **Per-chunk controls** — each chunk gets accept/reject/edit buttons; batch operations for the whole proposal
4. **Inline in the editor** — changes render in the main editor view, not a separate panel

---

## Architecture

### Operation Extraction Pipeline (Changeset-Driven)

**Key insight:** The Yjs proposal update already contains the exact edit operations. We don't need a diff algorithm at all.

```
ProposalReviewRuntime.deriveProposalOperations(proposal)
  → clone Y.Doc, attach ytext.observe(), apply update
  → YTextEvent.delta: [{ retain: N }, { delete: N }, { insert: "..." }, ...]
  → convert delta to EditOp[] with resolved positions + deleted text
  → groupIntoChunks(ops)                    // proximity-based grouping
  → ReviewChunk[]                            // chunk data model
  → CM6 decorations + widgets  OR  @codemirror/merge via diffConfig.override
```

### Why Changeset > Text Diff

| | Text Diff (current) | Changeset (proposed) |
|---|---|---|
| Source | `diffAlgo(baseText, proposedText)` | `YTextEvent.delta` from applying update |
| Accuracy | Approximate (diff may group/split differently than actual edits) | Exact (these ARE the actual edits) |
| Performance | O(n*m) diff computation | O(1) — just observe the apply |
| Prose quality | Noisy char-level unless we add word-level preprocessing | Natural operation boundaries (AI inserts/deletes at meaningful positions) |

### How It Works

```typescript
// 1. Clone doc, observe Y.Text, apply proposal update
const clone = cloneDoc(baseDoc);
const ytext = clone.getText("content");
let delta: Array<{ retain?: number; delete?: number; insert?: string }> = [];
ytext.observe((event) => { delta = event.delta; });
Y.applyUpdate(clone, proposalUpdate);

// 2. Convert delta to positioned EditOps
// delta = [{ retain: 42 }, { delete: 15 }, { insert: "She drifted through the moonlit garden," }]
// → EditOp { type: "replace", from: 42, deletedText: "She walked slowly...", insertedText: "She drifted..." }

// 3. Recover deleted text from base document using retain/delete positions
const baseText = baseDoc.getText("content").toString();
let cursor = 0;
const ops: EditOp[] = [];
for (const op of delta) {
  if (op.retain) { cursor += op.retain; }
  if (op.delete) {
    ops.push({ type: "delete", from: cursor, text: baseText.slice(cursor, cursor + op.delete) });
    cursor += op.delete;
  }
  if (op.insert) {
    ops.push({ type: "insert", at: cursor, text: op.insert });
  }
}
```

This matches exactly how `y-codemirror.next` maps Yjs ops → CM6 transactions (already proven in our dependency tree).

### EditOp Type

```typescript
interface EditOp {
  type: "insert" | "delete" | "replace";
  /** Position in base document */
  from: number;
  /** For delete/replace: end position in base document */
  to?: number;
  /** For delete/replace: the removed text */
  deletedText?: string;
  /** For insert/replace: the new text */
  insertedText?: string;
}
```

### Chunk Grouping

Group adjacent diff spans into **ReviewChunks**:

```typescript
interface ReviewChunk {
  id: string;
  proposalId: string;
  type: "insert" | "delete" | "replace";
  /** Line range in the base document this chunk covers */
  baseRange: { from: number; to: number };
  /** The deleted text (for delete/replace); undefined for pure inserts */
  deletedText: string | undefined;
  /** The inserted text (for insert/replace); undefined for pure deletes */
  insertedText: string | undefined;
  /** Diff spans within this chunk (for inline rendering) */
  spans: DiffSpan[];
  /** Accept/reject state */
  status: "pending" | "accepted" | "rejected";
}
```

**Grouping rules (prose-first):**
1. Adjacent insert+delete with overlapping line ranges → single `replace` chunk
2. Diff spans within the same paragraph (no blank-line separator) → merge into one chunk
3. Diff spans separated by ≤2 unchanged lines → merge (they're part of the same edit intent)
4. Cross-paragraph boundary → separate chunks (different narrative beats)
5. Large rewrites (>10 lines changed) → keep as single chunk with "expand" affordance

### Rendering: Two Modes

#### Mode 1: Unified Inline (Default)

Use `@codemirror/merge`'s `unifiedMergeView` with `diffConfig.override` to inject our changeset-derived `Change[]` instead of letting it run Myers diff:

```typescript
import { unifiedMergeView } from "@codemirror/merge";

// Convert our EditOps to @codemirror/merge Change[] format
const changes = editOpsToMergeChanges(ops, baseText);

const extension = unifiedMergeView({
  original: baseText,
  mergeControls: true,
  renderMergeControl: (view, chunk, side) => {
    return createChunkControlWidget(chunk, side, { onAccept, onReject });
  },
  // Override diff algorithm with our exact changeset operations
  diffConfig: { override: () => changes },
  highlightChanges: true,
});
```

**Fallback:** If `diffConfig.override` doesn't give us enough control (merge still normalizes presentationally), we build a fully custom renderer using CM6 `Decoration.widget` / `Decoration.mark` + `StateField` to render the EditOps directly. This is more work but gives exact operation fidelity.

#### Mode 2: Side-by-Side (Toggle)

Same changeset-derived `Change[]` injected via `diffConfig.override` on `MergeView`:

```typescript
const mergeView = new MergeView({
  a: { doc: baseText, extensions: [readOnly] },
  b: { doc: proposedText, extensions: [readOnly] },
  diffConfig: { override: () => changes },
  mergeControls: true,
  renderMergeControl: createChunkControlWidget,
  highlightChanges: true,
  gutter: true,
});
```

#### Mode 3: No Diff (Plain View)

Just show the proposed text in the editor with no diff decorations. Toggle off diff mode entirely.

**Toggle mechanism:**
- Store mode in `useUIStore`: `"unified" | "split" | "plain"`
- On toggle: reconfigure/remount the appropriate view
- Preserve scroll position by mapping line numbers between views

---

## Slices

### Slice 1: Changeset Extraction Engine

**Goal:** Extract exact edit operations from Yjs proposal updates using `YTextEvent.delta`, replacing text diffing entirely.

**Files:**
- **NEW** `packages/cm6-collab/src/review/changeset-extractor.ts`
  - `extractProposalOps(baseDoc: Y.Doc, yjsUpdate: Uint8Array, textKey?: string): EditOp[]`
  - Clones doc, attaches `ytext.observe()`, applies update, reads `event.delta`
  - Converts delta (retain/delete/insert) to positioned `EditOp[]` with recovered deleted text
  - Merges adjacent delete+insert into `replace` ops
- **NEW** `packages/cm6-collab/src/review/chunk-grouper.ts`
  - `groupIntoChunks(ops: EditOp[], proposalId: string): ReviewChunk[]`
  - Proximity-based grouping with paragraph-boundary awareness
- **NEW** `packages/cm6-collab/src/review/types.ts`
  - `EditOp`, `ReviewChunk`, view mode types
- **UPDATE** `packages/cm6-collab/src/review/runtime.ts`
  - Add `deriveProposalOperations()` alongside existing `deriveProposalReview()`
  - Returns `{ baseText, proposedText, ops, chunks }` instead of just strings
- **UPDATE** `packages/cm6-collab/src/index.ts` — export new types and functions

**Verification:** Unit tests: apply a known Yjs update, verify extracted ops match the exact insertions/deletions.

---

### Slice 2: Unified Inline Diff View

**Goal:** Replace the current side-by-side-only review panel with an inline unified diff using `unifiedMergeView`.

**Files:**
- **NEW** `packages/cm6-collab/src/review/unified-review.ts`
  - `mountUnifiedReviewView(params)` — wraps `unifiedMergeView` with prose diff config
  - Custom `renderMergeControl` producing accept/reject widgets per chunk
  - Returns handle with `update()`, `destroy()`, `getChunkStates()`
- **UPDATE** `frontend/src/features/documents/components/AIProposalReviewDiff.tsx`
  - Default to unified inline mode
  - Wire chunk-level accept/reject callbacks
- **UPDATE** `frontend/src/features/documents/components/AIProposalReviewPanel.tsx`
  - Add view mode toggle button (unified ↔ side-by-side)
  - Add batch controls: "Accept All", "Reject All"
  - Show chunk count and navigation (← Prev / Next →)
- **UPDATE** `frontend/src/features/documents/components/AIProposalReviewActions.tsx`
  - Add chunk-level action support alongside proposal-level

**Verification:** Visual test with a multi-paragraph fiction edit showing inline deletions (strikethrough) and insertions (highlighted) with per-chunk buttons.

---

### Slice 3: Side-by-Side Toggle + Chunk Navigation

**Goal:** Toggle between unified and side-by-side views; keyboard navigation between chunks.

**Files:**
- **UPDATE** `packages/cm6-collab/src/review/merge.ts`
  - Add prose diff config support to existing `MergeView` wrapper
  - Add `mergeControls` + `renderMergeControl` for per-chunk buttons in split view
- **UPDATE** `frontend/src/features/documents/components/AIProposalReviewDiff.tsx`
  - Toggle logic: store mode in `useUIStore`, remount on switch
  - Scroll position preservation across mode switches
- **NEW** `packages/cm6-collab/src/review/chunk-navigation.ts`
  - Keyboard commands: `nextChunk`, `prevChunk`, `acceptChunk`, `rejectChunk`
  - Keybindings: `Ctrl-]` / `Ctrl-[` for navigation, `Ctrl-Enter` / `Ctrl-Backspace` for actions
- **UPDATE** `frontend/src/core/stores/useUIStore.ts`
  - Add `proposalReviewMode: "unified" | "split"` state

**Verification:** Toggle between views preserves which proposal is selected; keyboard navigation cycles through chunks.

---

### Slice 4: Chunk-Level Partial Accept + Protocol

**Goal:** Accept/reject individual chunks within a proposal, not just all-or-nothing.

This requires a new approach: when accepting a chunk, we construct a **partial Yjs update** containing only that chunk's changes, apply it to the live doc, and mark the chunk as accepted. The proposal itself transitions to "accepted" only when all chunks are accepted (or remaining are rejected).

**Files:**
- **NEW** `packages/cm6-collab/src/review/partial-apply.ts`
  - `buildPartialUpdate(baseDoc: Y.Doc, chunk: ReviewChunk): Uint8Array`
  - Constructs a Yjs update that applies only the text changes in one chunk
  - Uses the chunk's `baseRange` + `insertedText` to compute the minimal edit
- **UPDATE** `packages/cm6-collab/src/proposals/contracts.ts`
  - Add `ProposalPartialAcceptCommand` type
  - Add chunk tracking to proposal state
- **UPDATE** `packages/cm6-collab/src/review/runtime.ts`
  - Track per-chunk accept/reject state
  - Recompute remaining chunks after partial accept (positions shift)
- **UPDATE** Backend handler if needed for partial accept tracking

**Verification:** Accept chunk 1 of a 3-chunk proposal → only chunk 1's changes appear in the document; chunks 2-3 remain pending with correct positions.

---

### Slice 5: Edit-Before-Accept

**Goal:** Allow the writer to modify a proposed change before accepting it.

**Files:**
- **UPDATE** `packages/cm6-collab/src/review/unified-review.ts`
  - Add "Edit" button to chunk controls
  - When editing: make the proposed text region editable, add a "Save & Accept" / "Cancel" action pair
- **NEW** `packages/cm6-collab/src/review/chunk-editor.ts`
  - Manages the editable state for a single chunk
  - On "Save & Accept": builds a Yjs update from the user-edited text instead of the original proposal text
- **UPDATE** Proposal status tracking to distinguish `accepted` vs `accepted_with_edits`

**Verification:** Click "Edit" on a chunk → region becomes editable → modify text → "Save & Accept" applies the modified version.

---

## Open Questions

1. **`diffConfig.override` fidelity** — `@codemirror/merge@6.12.0` supports `diffConfig.override` returning `Change[]`, but merge still runs presentational normalization (`presentableDiff` path). Need to verify: does `override` bypass normalization, or does merge still re-process the changes? If it re-processes, we need a fully custom decorator-based renderer instead.

2. **Delta edge cases** — Can a single proposal update emit multiple `YTextEvent` deltas (e.g., if the AI tool made multiple `str_replace` calls in one proposal)? If so, we need to collect across events. Need to test with real multi-edit proposals.

3. **Partial accept protocol** — Should partial accept be purely client-side (apply chunks locally, send final full-accept when done) or should the backend track per-chunk state? Client-side is simpler but loses audit trail.

4. **Chunk granularity tuning** — The grouping rules (≤2 unchanged lines → merge) need real-world testing with fiction prose. May need to be configurable or adaptive.

5. **Review mode toggle** — Should there be a global "Review Mode" that shows all pending proposals inline simultaneously, or should proposals be reviewed one-at-a-time (current model)?

## Dependencies

- `@codemirror/merge@^6.12.0` (already installed)
- `diff-match-patch@^1.0.5` (already installed)
- No new packages required

## Existing Infrastructure to Reuse

| What | Where | How |
|------|-------|-----|
| Proposal lifecycle | `packages/cm6-collab/src/proposals/contracts.ts` | Chunk state extends proposal state |
| Review runtime | `packages/cm6-collab/src/review/runtime.ts` | `deriveProposalReview()` feeds the diff engine |
| Merge view wrapper | `packages/cm6-collab/src/review/merge.ts` | Extend for prose diff config |
| Group accept | `contracts.ts:119`, `collab_proposal.go:212` | Batch operations use existing `proposalGroupId` |
| `diff-match-patch` | `frontend/package.json` | Already used in `DiffPreview.tsx` for thread panel |
| `normalizeForDiff()` | `runtime.ts:141` | Reuse for prose normalization |
