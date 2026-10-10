# domains/context/tree

The visibility owner. A draft's new document or folder is a hidden live row: in no
live view, and an ordinary node at the draft's location in that draft's view. This
module decides what each view shows and spells where nodes are.

- `tree-view.ts`: `TreeView`, the `TreeReader` (path and id lookups, identity status,
  occupants, tree state, lineage) and the relations readers select from
  (`visibleDocuments(view)`, `visibleFolders(view)` and their raw-SQL forms).
- `tree-view-sql.ts`: the SQL behind them. Diagnostic `identityDocuments` and
  `identityFolders` retain deleted lifecycle facts, but apply the same view visibility
  and draft location. Availability uses them to distinguish tombstones from missing
  identities; they never authorize bytes. Plain-field helpers support nested Drizzle
  selections, which cannot select a Subquery as a whole.
- `tree-addresses.ts`: identity rows by id or name and their addresses, hidden and
  deleted included; the folder-chain walk.

**The one rule: the hidden predicate lives here only.** Only `tree-view-sql.ts` reads
`documents.hidden` / `folders.hidden`. Everything else, inside this module or out,
composes the view. `pnpm check:tree-visibility` enforces the outside; review enforces
the inside. A reader that needs visibility takes a `TreeView`, never the column.

Placement (reveal, restore), hidden-node lifecycle, draft tree rows, absorb/split and
the batch move primitive join this directory in later lanes; the contract is
`work/model-tool-surface/impl-foundation/contract.md` §3 in the
[Meridian Flow docs repository][docs].

[docs]: https://github.com/haowjy/meridian-flow-docs
