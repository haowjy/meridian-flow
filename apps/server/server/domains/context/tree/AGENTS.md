# domains/context/tree

The visibility owner. A draft's new document or folder is a hidden live row: in no
live view, and an ordinary node at the draft's location in that draft's view. This
module decides what each view shows, spells where nodes are, and owns the hidden-node
lifecycle (create, reveal, end of use, repair). Files and contracts:
[.context/CONTEXT.md](.context/CONTEXT.md).

**The one rule: the hidden predicate lives here only.** Only `tree-view-sql.ts` reads
`documents.hidden` / `folders.hidden`, and only the lifecycle writers (`node-rows.ts`
inserts, `placement.ts` reveals) write them.
Everything else, inside this module or out, composes the view: a reader that needs
visibility takes a `TreeView`, never the column. `pnpm check:tree-visibility` enforces
the outside; review enforces the inside.

- **Lock order.** In-process leases before any transaction, then Work rows, the draft
  row, namespace advisory keys (key order), and only then document locks (id order).
  Never take a namespace lock while holding a document lock: compute the full namespace
  set first, then revalidate (`acquireEndUseScope` is the pattern).
- **Tombstone, never delete.** A hidden node ends as a tombstone; its storage is
  released, but the row and everything pointing at it stay, so a bound link still reads
  gone.
- **A draft's create never seeds live content.** A new text row gets an empty live Yjs
  document; the text lives in the draft's branch until Apply.
- **Every namespace lifecycle change bumps `location_version`** on what it changes
  (`node-locations.ts`). A split and an absorb's reparenting move nothing in any view,
  so they bump nothing but the absorbed folder's tombstone.
- **Normalization is writes-only.** Absorb never refuses a hidden/live clash;
  `treeState` owns the observable clash in each draft's view.
- **Names arrive canonical; claims ask as a kind.** Callers pass the contracts name
  codec's canonical document name, so path matching stays literal. Anything deciding
  whether a node may stand at a path asks `as: "document" | "folder"` (`NameClaim`): a
  create, placement or move, Apply's holds, and `treeState`'s clash diagnostics (a
  leaf as a document, its ancestors as folders), so review and Apply can't disagree.
  The claim also meets the shared namespace through the one rule, `namespaceName`: a
  folder holds its document alias (`Lore.md` holds `Lore`). Folders never meet folders
  through it. The batch move's planned namespace uses the same rule. Browsing (ls,
  stat, read, link resolution) never asks as a kind.
- **Tree writes don't refresh the catalog.** They return what they placed or
  tombstoned; the caller reconciles in its own transaction (the store, the mover, the
  Apply step's completion transaction, the Discard kernel).

The contract is `work/model-tool-surface/impl-foundation/contract.md` §3, §6–§8, §12
and §14 in the [Meridian Flow docs repository][docs].

[docs]: https://github.com/haowjy/meridian-flow-docs
