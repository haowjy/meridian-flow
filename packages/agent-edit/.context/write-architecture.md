# Write architecture

## Architecture

`write.ts` is the composition façade; behavior belongs in the module that owns
its concern.

### Codec pipeline
```
@meridian/markup: source string → unified parser → mdast → BlockCodec dispatch → MarkCodec dispatch → PM nodes
@meridian/markup: PM nodes → BlockCodec.serialize → MarkCodec.serialize → mdast → unified stringify → source string
```
Block hash prefix added by `AgentEditCodec.serializeBlock()` at render time (not stored as
attribute). In the built-in adapter the hash is derived from the adapter-internal
Y.XmlElement CRDT item ID (`clientID + clock`); kernel callers see only the
neutral `BlockRef`.

### Semantic certification and apply (`src/semantic-edit-ir.ts`, `src/apply/tiers.ts`)
The resolver emits `SemanticEditIRV1` bound to the exact input Yjs revision. It
declares scope and deletion ranges plus a disjoint, exhaustive partition of
each output into preserved continuation, fresh payload, copy, or certified
restoration. A whole-scope zero-continuation edit uses the distinct
`fullScopeFreshReplacement` intent. Validation rejects stale revisions,
out-of-scope sources, missing/overlapping output claims, restoration without a
retained certificate, and UTF-16 surrogate splits before mutation.

Plain same-block find-all emits one `textRanges` edit with exact, ordered match
spans. The adapter adds those replacements back-to-front to one ProseMirror
`Transform` and projects each exact step inside one Yjs transaction. Unmatched
gaps therefore keep their CRDT items; the semantic IR partitions the replacement
window into fresh payload and `materialization: "retained"` preserved runs.
No run in such an IR needs a continuation/restoration fact — retained gaps
keep their original roots visible, and the fresh payloads are agent-born by
normal insertion attribution — so the write façade skips provenance
materialization for the whole `textRanges` IR rather than filtering runs.
Single-match output retains the existing `text` shape. Formatted
and cross-block finds keep the serialized-markdown reconciliation path.

### 3-tier apply (`src/apply/tiers.ts`)
Preflight-before-mutate discipline: Phase 1 (read-only) validates all
references, parses content, computes offsets, and validates the semantic IR.
Phase 2 (inside `doc.transact()`) applies pre-computed operations. Find-based
text edits deliberately bypass the direct-text fast path so their single PM
lowering is the certification seam; other eligible plain edits retain Tier 1.

| Tier | Kind | Mechanism |
|---|---|---|
| 1 | `text` with same-mark span | Direct Y.XmlText delete + insert |
| 2 | `text` crosses mark boundary/formatting change, `textRanges`, or a same-type complex block changes | Adapter-owned inline, exact multi-range, or whole-block replacement + per-block updateYFragment |
| 3 | `insert` / `delete` | Adapter-owned block insert/delete (Y.XmlElement fragment ops in the built-in adapter) |

Last-block edge case: deleting the only remaining block clears text instead of
structurally deleting (the built-in adapter preserves ProseMirror `doc(block+)`
internally). Structural replacement inserts its new blocks before deleting old
parents, so a non-empty requested document never leaves a cleared trailing block.

### Undo/redo (`src/undo/`)

Reversal is a single cold reconstruction path from `UpdateJournal`. It replays
the retained durable update log (plus only a seq-0 baseline checkpoint when the
host initialized a document that way), assigns per-reconstruction `Symbol` tokens,
creates a fresh local `Y.UndoManager`, tags only the requested target forward
update seqs with the tracked token, runs undo/redo, and extracts update bytes.
The target seqs come from mutation rows: undo targets currently `active` rows for
the turn; redo targets `reversed` rows whose `undoUpdateSeq` matches the redo
target. This journal-backed model is authoritative.

Forward agent writes still use a stable transaction origin `Symbol` per
`(docId, threadId)` pair via `ThreadOriginRegistry`. That origin is for Yjs
transaction attribution and same-actor filtering only; write selection for
reversal comes from durable journal metadata (`w<N>` / mutation row
`createdSeq`; `turnId` remains context), not live undo stack items.

Redo targets are selected from durable `ReversalRecord` rows with
`status: "reversed"`; there is no runtime redo stack or rehydration cache. Redo
consumption is authoritative at persist time: `persistRedo()` rechecks the
doc+thread+turn reversal is still `status: "reversed"` inside the append
transaction, marks it `status: "redone"`, and returns `consumed: false` without
appending when another session already used it.

Redo staleness is writer-specific. A later `human:*` journal row withdraws redo;
system reversal/bookkeeping rows and later agent rows do not. The planner and
persist-time watermark guard use that same classification. `planUndo()` and
`planRedo()` are the shared authority for read-model availability and command
execution, so those paths cannot disagree except across a race.

Lineage has two distinct persisted authorities.
`document_yjs_reversals.redo_update_seq` records the current active redo closure
(state): handles that are active because of the same redo update must undo
together. `document_yjs_reversal_ops` records durable reversal op identity
(history): old undo/redo update seqs are exempt from dependency blocking even
when the current state has moved on. Both authorities compact with the retained
Yjs update log so closure and dependency checks only target retained update seqs.
Hosts may append a `system:reconcile` update after separately attributed rows in
the same admission to make cold replay causally complete. That row is coverage
for those authored rows, not a later semantic edit, so lineage dependency
evaluation ignores it; the authored rows remain the reversal targets.
The pure lineage entry point is `selectUndoClosure(...)`; callers pass the
journal snapshot, reversal rows, unfiltered candidate mutation rows, selected
handles, candidate handles, and reversal-op seqs, then receive the undo closure or
unavailable verdict. The helper steps behind that API (compatible groups, boundary
expansion, seq ownership, dependency evaluation) are private implementation
details.

**Write-level undo:** each `write()` call is its own durable mutation row. Undoing without a selector reverses exactly the latest active write. Each write has a stable per-(document, thread) handle (`w1`, `w2`, …) stored on mutation metadata and never renumbered. `undo`/`redo` can target `{to:"w3"}`, an inclusive `{from:"w2", to:"w5"}` range, `{last:N}`, or `{all:true}`. Range reconstruction still uses Yjs UndoManager item identity: selected writes are tracked, non-selected/concurrent updates replay untracked, so same-area concurrent merge behavior is unchanged. User-facing undo notifications carry per-handle turn mappings (`writeHandleTurns`) because one closure can span multiple turns; `turnId` is only a representative fallback for grouping/reporting.

Multiple handles backed by the same durable journal update are one reversal
boundary. Selecting any member expands to every handle sharing that update, so
content and mutation status cannot diverge after a folded branch Apply.


### CRDT-neutral seam, ProseMirror content currency

The resolver→apply kernel is neutral across the CRDT axis: Yjs documents and
blocks are carried as opaque `DocHandle`/`BlockRef` handles, and resolver/apply
code asks `AgentEditModel` for identity, lookup, mutation, projection, and
serialization. That does **not** mean the package is ProseMirror-neutral.
`codec-types.ts` still aliases `Block = PMNode`, `ParsedContent` still transits
the kernel, and resolver code still inspects PM block shape (`type.name`,
`isTextblock`, heading attrs, body serialization). Full PM-out-of-kernel work is
deferred in [TODO.md](TODO.md).
