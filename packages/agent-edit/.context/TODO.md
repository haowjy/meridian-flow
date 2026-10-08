# TODO — agent-edit deferred work

Keep the agent-editing protocol reusable across CRDT and tool implementations,
but do not freeze a public abstraction until a second implementation exposes
the seam it needs.

## Selective Discard reconstruction reuse

Work-draft selective Discard and live undo both reconstruct a peer from ordered
Yjs updates, but Discard reverses every branch journal row in a server-vended
class, including rows from different actors. A reusable agent-edit primitive
would need to accept multiple update identities without importing branch-review
concepts.

Active Work-draft journal rows must remain immutable and individually
addressable. Collab storage owns that invariant; agent-edit should not infer it
from a snapshot.

Design: [inline-diff-decoration-architecture.md] in
`meridian-flow-docs/work/human-undo-affordance/design/`.

[inline-diff-decoration-architecture.md]: https://github.com/haowjy/meridian-flow-docs/blob/main/work/human-undo-affordance/design/inline-diff-decoration-architecture.md

## Selective undo inside one turn refuses a safe undo

`undo/journal-dependencies.ts` counts a later row's `origin`/`rightOrigin`
anchor on the undone text as a dependency. The server checks a whole turn at
once, so this never bites there, but `planUndo` checks single writes: two
`insert`s in one turn, then `write undo since w1 to w1`, returns
`cant_undo_dependent` (w2 sits after w1, not inside it). Undoing `w1..w2`
works. Fix by ignoring a later row whose only link to the undone text is
positional (it anchors on the undone text's edge and nothing it inserts sits
inside it), keeping the server and `planUndo` on the one rule.

## `find` misses text spelled with character references

The codec encodes edge characters next to emphasis and strike as character
references (`Li&#x6E;~~&#x20;Feng nasc~~ent`), so `find: "Lin Feng"` does not
match. Decode character references in the find view
(`src/model/markdown-text-view.ts`, used by `src/resolver/find.ts`) so `find`
matches the text a writer sees.

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

- **Public `DocumentPort`/`HistoryPort` as frozen contracts.** (Issue #83.) The
  seam is internal, deliberately unfrozen until a second implementation reveals
  its shape.

- **Tool registry + capability gating.** Over one closed command set a registry is
  indirection without decoupling; with one full-capability impl, capability gating
  gates nothing and can't be tested. Wait for a second tool surface / impl. (Zod
  single source, `read` rename, and the query/write/history split already landed.)

- **`HistoryPort` as a real seam.** (Issue #83.) Undo is Yjs-married cold
  reconstruction (journal + binary updates + `UndoManager`); a 2-method port hides
  almost none of it. Keep undo Yjs-internal until a second backend needs it.

- **OSS packaging.** (Issue #84.) `yjs` as a peer dep (today a direct dep); engine
  source importing no Yjs.

- **Surgical formatting.** Replace the `updateYFragment` reconcile with a
  mark-aware sequence diff (parse → plain-text edit + `format` range diff, tree
  fallback for inline non-text nodes). Token-aligned, not minimal-edit-distance
  (minimal ≠ intent). Narrow payoff now that matched blocks already diff in
  place; build on real merge observations,
  not on spec.
