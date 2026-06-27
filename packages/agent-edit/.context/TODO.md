# TODO — CRDT-neutral kernel refactor (internal-first)

North-star: the agent-editing protocol (find/replace, block-hash addressing,
resolve→apply) usable on any CRDT, any tool vocabulary, extractable as a library.
We do **not** build the public surface from one implementation — we move toward it
internally and let a second implementation force the contract shapes.

Source of truth: design doc `agent-edit-write-loop/design/crdt-text-port.md`
(meridian-flow-docs work area).

## Now — Step 1: de-Yjs the edit payload

`ResolvedEdit` carries an opaque, branded `BlockRef` instead of `Y.XmlElement`;
`apply/types.ts` stops importing `yjs`. `BlockRef` is the **branded live element**,
never a fresh wrapper — object identity must stay intact so `===` grouping,
tombstone `Set`/`indexOf`, the descending sort, and `validateLiveBlock` keep
working. The adapter owns the sole `unwrap(ref)`.

Scope boundary: Step 1 de-Yjs's the edit *payload* only. `doc: Y.Doc` threading
and the model's mutation-verb signatures stay Yjs for now — those move in Step 2.

## Next — Step 2: concentrate Yjs/PM behind `ports/model.ts`

Goal: resolver + apply stop importing `yjs`. Pull behind the `AgentEditModel` seam:

- **Identity / hashing** — `block-hash.ts` reads `_item.id.client/clock` directly.
  Move behind an `identity()` concept; callers stop knowing the hash is
  `client:clock` or calling `lookupBlockHash(doc, …)` directly.
- **Mutation verbs + PM replacement** — `model/y-prosemirror.ts`. Execution already
  routes through model verbs; remove remaining `doc: Y.Doc` from seam signatures.
- **Inline mark structure** — `collectTextRuns` (Yjs `toDelta()` reach-in in
  `apply/tiers.ts`) → neutral `inlineRuns(block): TextRun[]` on the seam. Keep
  Tier 1-vs-Tier 2 *selection* in the kernel (Option A).
- **Read-path projection** — `model/block-projection.ts`, `tool/document-renderer.ts`,
  `apply/echo.ts` → re-point onto `blocks() + identity() + serializeBlocks()`.

Stays Yjs (CRDT-runtime plumbing, not content-model leakage; do **not** churn):
`tool/runtime-store.ts`, `tool/mutation-commit.ts`, `tool/response-staging.ts`,
`undo/*`, `ports/document-coordinator.ts`.

## Deferred — reopen when earned (2nd CRDT/representation, or 2nd tool surface)

- **Public `DocumentPort`/`HistoryPort` as frozen contracts** — today the seam is
  internal, deliberately unfrozen.
- **Tools layer** — registry, Zod schemas (single source → `z.toJSONSchema()` for
  the model + `schema.parse()` for validation), `query`/`write` split, capability
  gating, `view`→`read` rename.
- **`HistoryPort` as a real seam** — undo is Yjs-married cold reconstruction
  (journal + binary updates + `UndoManager`); a 2-method port hides almost none of
  it. Keep undo Yjs-internal until a second backend needs it.
- **OSS packaging** — `yjs` as a peer dep (today a direct dep); engine source
  importing no Yjs.
- **Tier-2 surgical formatting** — replace the `updateYFragment` reconcile with a
  mark-aware sequence diff (parse → plain-text edit + `format` range diff, tree
  fallback for inline non-text nodes). Token-aligned, not minimal-edit-distance
  (minimal ≠ intent). Narrow payoff vs Tier 1; build on real merge observations,
  not on spec.
