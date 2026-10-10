# domains/context/tree

The visibility owner. A draft's new document or folder is a hidden live row: in no
live view, and an ordinary node at the draft's location in that draft's view. This
module decides what each view shows and spells where nodes are.

- `tree-view.ts`: `TreeView`, the `TreeReader` (path and id lookups, identity status,
  occupants, tree state, lineage) and the relations readers select from
  (`visibleDocuments(view)`, `visibleFolders(view)` and their raw-SQL forms).
- `tree-view-sql.ts`: the SQL behind them. Diagnostic `identityDocuments` and
  `identityFolders` derive selection and placement from the canonical branches, then
  add only non-hidden deleted lifecycle and malformed-identity diagnostics. Hidden
  tombstones are absent even with stale draft change rows. Availability distinguishes
  formerly live tombstones from missing identities; diagnostics never authorize bytes. Plain-field helpers support nested Drizzle
  selections, which cannot select a Subquery as a whole.
- `tree-addresses.ts`: identity rows by id or name and their addresses, hidden and
  deleted included; the folder-chain walk.
- `hidden-nodes.ts`: the hidden-node lifecycle. `createInDraft` makes or joins a
  draft's hidden row (binaries are never joined); `createLive` reveals a hidden
  document at a live create's path, or the one a create names by id;
  `ensureLiveFolderPath` reveals a hidden folder instead of making a twin;
  `place` is the one placement step (reveal, restore) with ancestors; `endUse`
  tombstones what no draft uses any more; `retractCreate` reverses a draft create
  for a rolled-back reply. Test-only hook points (`setHiddenNodeHook`) let the DB
  suites interleave these fences.
- `draft-tree-store.ts`: writes of `draft_tree_changes` (a draft's `created` rows).

**The one rule: the hidden predicate lives here only.** Only `tree-view-sql.ts` reads
`documents.hidden` / `folders.hidden`, and only `hidden-nodes.ts` writes them.
Everything else, inside this module or out, composes the view. `pnpm check:tree-visibility` enforces the outside; review enforces
the inside. A reader that needs visibility takes a `TreeView`, never the column.

Locks, in order, before anything here takes a document lock: Work rows, the draft
row, then namespace advisory keys; hidden nodes are tombstoned, never hard-deleted,
and a draft's create never seeds live Yjs. Absorb/split and the batch move
primitive join this directory in later lanes; the contract is
`work/model-tool-surface/impl-foundation/contract.md` §3 in the
[Meridian Flow docs repository][docs].

[docs]: https://github.com/haowjy/meridian-flow-docs
