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
- `hidden-node-types.ts`: the lifecycle's vocabulary (claims, reveal expectations,
  create results), with no database import, so ports can name it.
- `hidden-nodes.ts`: the hidden-node lifecycle. `createInDraft` makes or joins a
  draft's hidden row (binaries are never joined); `createLive` claims what a live
  create planned: it reveals the hidden document at the path, or exactly the one a
  create named by id, which must be hidden, used by a draft and in the caller's
  project (`findRevealIdentity` reads it by its physical row);
  `ensureLiveFolderPath` reveals a hidden folder instead of making a twin;
  `place` is the one placement step (reveal, restore) with ancestors; `endUse`
  tombstones what no draft uses any more and prunes every emptied hidden ancestor,
  deepest first; `retractCreate` reverses a draft create for a rolled-back reply,
  asking collab (`retractBranch`) whether the create stands. Collab owns the
  draft's branch: tree never deletes branch rows.
- `draft-tree-store.ts`: writes of `draft_tree_changes` (a draft's `created` rows).
- `folder-normalization.ts`: what live folder operations do to hidden nodes. A
  visible folder arriving at a hidden folder's path absorbs it (`absorbHiddenFolder`,
  `absorbAt`; opposite-kind collisions are reported, never refused, and are clashes
  in the drafts that use them); a live delete or a move out of where drafts can
  hold a folder (another project, a Work-owned or lineage Scratch source) splits
  hidden contents into
  ancestor-closed hidden twins at their paths. A split is planned from a snapshot
  (`planSplit`) and written once (`applySplit`); a delete plans its own subtree
  (`splitHiddenContents`). Change rows naming an absorbed or split folder follow it.
- `node-moves.ts`: the phased batch move primitive (`prepareMoves`, `vacateMoves`,
  `installMoves`, `recordMoves`; `moveNodes` runs all four). Prepare builds one
  node-keyed plan before any write: what each selected root carries (a selected
  descendant owns its own subtree), every final slot checked for occupancy, the
  split from original coordinates. Install and record consume only that plan; a
  temporary vacate name never outlives install. The live mover's single moves use
  it; Apply's relocation calls the phases separately.
- `test-hooks.ts`: test-only hook points (`setTreeHook`) the DB suites use to
  interleave these fences; a no-op in production.

**The one rule: the hidden predicate lives here only.** Only `tree-view-sql.ts` reads
`documents.hidden` / `folders.hidden`, and only `hidden-nodes.ts` (and
`folder-normalization.ts`, for split twins) writes them.
Everything else, inside this module or out, composes the view. `pnpm check:tree-visibility` enforces the outside; review enforces
the inside. A reader that needs visibility takes a `TreeView`, never the column.

Locks, in order, before anything here takes a document lock: Work rows, the draft
row, then namespace advisory keys; hidden nodes are tombstoned, never hard-deleted,
and a draft's create never seeds live Yjs. Every namespace lifecycle change
bumps `location_version` on what it changes; a split and an absorb's reparenting
move nothing in any view, so they bump nothing but the absorbed folder's
tombstone. The contract is `work/model-tool-surface/impl-foundation/contract.md`
§3, §7 and §8 in the [Meridian Flow docs repository][docs].

[docs]: https://github.com/haowjy/meridian-flow-docs
