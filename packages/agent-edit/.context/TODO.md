# TODO — agent-edit deferred work

Keep the agent-editing protocol reusable across CRDT and tool implementations,
but do not freeze a public abstraction until a second implementation exposes
the seam it needs.

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
  single source, `read` rename, and the query/write split already landed.)

- **OSS packaging.** (Issue #84.) `yjs` as a peer dep (today a direct dep); engine
  source importing no Yjs.

- **Surgical formatting.** Replace the `updateYFragment` reconcile with a
  mark-aware sequence diff (parse → plain-text edit + `format` range diff, tree
  fallback for inline non-text nodes). Token-aligned, not minimal-edit-distance
  (minimal ≠ intent). Narrow payoff now that matched blocks already diff in
  place; build on real merge observations,
  not on spec.
