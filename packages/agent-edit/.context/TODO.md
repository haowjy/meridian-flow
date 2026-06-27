# TODO — agent-edit deferred work

North-star: the agent-editing protocol (find/replace, block-hash addressing,
resolve→apply) usable on any CRDT, any tool vocabulary, extractable as a library.
We do **not** build the public surface from one implementation — a second
implementation forces the contract shapes.

Source of truth: design doc `agent-edit-write-loop/design/crdt-text-port.md`
(meridian-flow-docs work area).

**Landed:** the resolver→apply kernel is CRDT-neutral (`BlockRef`/`DocHandle`,
neutral `AgentEditModel` seam; Yjs lives only in `model/` + runtime/undo plumbing),
Tier 2 construction is behind an adapter verb, and the write-command schema is one
Zod source (`tool/command-schema.ts`; `view`→`read`; query/write/history split).
Below is what remains deferred.

## Deferred — reopen when earned

- **Full ProseMirror-out-of-kernel.** (Issue #70.) The CRDT (Yjs) axis is
  neutral; the content-representation axis is not — and the remaining coupling is
  now *asymmetric*:
  - *Live-doc side — already neutral.* `resolver/*` inspects live blocks only
    through the `AgentEditModel` seam (`isHeading` / `headingLevel` /
    `getBlockType`, all on `BlockRef`).
  - *Codec-parsed side — still raw ProseMirror.* `codec-types.ts` aliases
    `Block = PMNode` (from `@meridian/markup`), and `resolver/resolve.ts` inspects
    `codec.parse()` output via PM API at 5 sites: `newBlock.type.name` (×2),
    `newBlock.attrs.level` (×2), `block.isTextblock`.

  Done = reshape the `@meridian/markup` `ParsedContent` boundary so parsed blocks
  expose type / heading-level / textblock-ness through a neutral descriptor (or a
  codec method), letting the resolver query parsed blocks the way it already
  queries live ones; then `Block` stops aliasing `PMNode`. Deferred: no non-PM
  content target exists, so the abstraction would be cosmetic over one impl. The
  `Codec` / `DocumentModel<Block>` seams are preserved.

- **Public `DocumentPort`/`HistoryPort` as frozen contracts.** The seam is
  internal, deliberately unfrozen until a second implementation reveals its shape.

- **Tool registry + capability gating.** Over one closed command set a registry is
  indirection without decoupling; with one full-capability impl, capability gating
  gates nothing and can't be tested. Wait for a second tool surface / impl. (Zod
  single source, `read` rename, and the query/write/history split already landed.)

- **`HistoryPort` as a real seam.** Undo is Yjs-married cold reconstruction
  (journal + binary updates + `UndoManager`); a 2-method port hides almost none of
  it. Keep undo Yjs-internal until a second backend needs it.

- **OSS packaging.** `yjs` as a peer dep (today a direct dep); engine source
  importing no Yjs.

- **Tier-2 surgical formatting.** Replace the `updateYFragment` reconcile with a
  mark-aware sequence diff (parse → plain-text edit + `format` range diff, tree
  fallback for inline non-text nodes). Token-aligned, not minimal-edit-distance
  (minimal ≠ intent). Narrow payoff vs Tier 1; build on real merge observations,
  not on spec.
