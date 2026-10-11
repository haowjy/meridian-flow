# context/tree: views, identity and the hidden-node lifecycle

The rules are in [../AGENTS.md](../AGENTS.md). This file is the map: what each view
shows, how a document's identity reads, and which file owns which part of the
lifecycle. The full contract is `impl-foundation/contract.md` §3 (tree view) and §14
(lock order) in the [Meridian Flow docs repository][docs].

## Views

`TreeView` is `LIVE_TREE` or `{ kind: "draft", draftId }`. Readers select from
`visibleDocuments(view)` / `visibleFolders(view)` (Drizzle subqueries) or their raw-SQL
forms `visibleDocumentsSql(view)` / `visibleFoldersSql(view)`. Subqueries, not CTEs: a
reader can't forget to attach one, and Postgres flattens the live one, so live readers
keep their plans.

- **Live:** rows not deleted and not hidden.
- **Draft D, documents:** a `UNION ALL` of live rows D says nothing about, and the rows
  D has a change row for, at D's location (`draft_located`), hidden ones only when D
  created them. Branch two is bounded by the change table's `draft_id` key prefix.
- **Draft D, folders:** live folders, plus the hidden folders D places something under
  (and their ancestors). Folders have no change rows yet; a folder D sees is implied by
  what D placed.

A path two visible nodes share answers `ambiguous` with every `NodeRef`; a live absorb
can produce it. Normalization performs writes only; `treeState` owns observable
draft clashes.

## Which drafts may hold a document

`draft-ownership.ts` owns the one rule (D20 under 12b): draft D may hold a document in
D's project, or in the personal `user://` source of the account that owns D's project
(`draftMayHold`). That source lives in the account's personal project, so one hidden
`user://` document can be shared by drafts in several projects of one account; never by
another account's. Branch admission, file facts (and so the review route), reveal
identity and move splits all ask it. Use counts are per document: end of use, Discard,
purge, repair and reveal authority count every active draft that uses the row, since only
drafts that may hold it ever do.

## Identity status

`identityStatus(view, ids)` decides each id in this order: a hidden tombstone is `gone`;
a row the view shows is `visible` (with `hidden` and the reader's own draft when it is
a draft's node); a hidden row some active draft uses is `hidden` (the reader's draft's
use first, else the oldest), with every user in `usedBy`; a hidden row no draft uses is
`gone` and is scheduled for repair; a deleted row is `deleted` with its last address.
A status whose address can't be spelled is `gone`. Link presence ("in a draft",
deleted, gone) reads only this status.

`treeState(D, edited, only)` lists D's created documents (only those ids when `only` is
given) and the edited documents the caller names, each spelled at D's location and at
its row's, with the first conflict that applies: a clash with another node at the
target path or a needed folder's path, `deleted_live`, `relocated`, else `none`.

`lineages(view, ids)` is the bulk file-facts reader: visible locations, deleted
identity fallback and folder chains are read for the set. `lineage` delegates
for a single id. Neither exposes hidden nodes outside the requested draft.

## Files

| File | Owns |
|---|---|
| `tree-view.ts` | `TreeView`, the `TreeReader` (path and id lookups, `childAt` for one step of a walk, identity status, occupants, tree state, single and batched lineage, project of a document) and the re-exported relations |
| `tree-view-sql.ts` | the SQL behind them, and the only reader of the hidden columns. Diagnostic `identityDocuments` / `identityFolders` add non-hidden deleted and malformed rows for availability; hidden tombstones never appear, and diagnostics never authorize bytes |
| `tree-addresses.ts` | identity rows by id or name and their addresses, hidden and deleted included; `loadFolderChains`; `spellNodeAddresses`, which carries lineage Scratch's `rootThreadId` |
| `hidden-node-types.ts` | the lifecycle's vocabulary (claims, reveal expectations, create results) with no database import, so ports can name it |
| `creates.ts` | `createInDraft` makes or joins a draft's hidden row (binaries never join). `findLiveCreateCandidate` and `findRevealIdentity` are a live create's discovery, holding nothing; `createLive` claims what that create planned: reveal the hidden document at the path or the one named by id, or insert. One candidate picker serves both and repairs on touch |
| `placement.ts` | the one way into the live tree: `place` reveals or restores targets with their ancestors; `ensureLiveFolderPath` reveals a hidden folder rather than making a twin; `walkFolders` is the one folder walk |
| `end-use.ts` | `endUse` drops a draft's rows and settlements on documents it created; `tombstoneUnused` tombstones what no draft uses, releases its storage and prunes emptied hidden ancestors. `acquireEndUseScope` is the verified lock every end of use takes (Discard, purge, repair); a document that moved to an unlocked source throws `EndUseScopeChangedError`. `retractCreate` reverses a rolled-back reply's create |
| `hidden-node-repair.ts` | repair on touch, one per composition: a hidden node no draft uses, met by a reader or a create, is tombstoned in its own transaction and reported as a `context.hidden-node.repaired` warn event after commit |
| `node-rows.ts` | `insertDocumentRow` (the one `documents` insert: hidden or live, text with its projection or storage-backed; a live row claims its location), folder inserts, tombstones, a tombstone's storage release (live Yjs, branches, derived rows, its own link rows) and document locks in id order |
| `node-locations.ts` | location claims (`claimDocumentLocation`), relocation history (`recordLocationHistory`) and `bumpLocationVersions` |
| `draft-ownership.ts` | `draftMayHold` and its loaders (a draft's holder, a source's or document's owner); `draftReachKept`, whether a move keeps every draft that may hold a node able to |
| `draft-tree-store.ts` | `draft_tree_changes` writes: `recordCreated` (a draft's `created` rows) and `dropDocumentRows` |
| `folder-normalization.ts` | what live folder operations do to hidden nodes: a visible folder arriving at a hidden folder's path absorbs it (never refused; clashes are read through the tree view); a live delete, or a move out of where drafts can hold a folder, splits hidden contents into ancestor-closed hidden twins (`planSplit` from a snapshot, `applySplit` once). Change rows follow |
| `node-moves.ts` | the phased batch move: `prepareMoves` builds one node-keyed plan before any write, then `vacateMoves`, `installMoves`, `recordMoves`. The live mover runs all four; Apply's draft tree step (`collab/adapters/drizzle-draft-tree-step.ts`) runs prepare, vacate and install before text admission and record after it |
| `test-hooks.ts` | test-only hook points (`setTreeHook`) that DB suites use to interleave fences; no-ops in production |

## Catalog and locks

Tree writes return what they placed; the caller reconciles the catalog in its own
transaction. The context store and the mover refresh after their writes. Apply's draft
tree step refreshes every affected current and final source inside the completion
transaction, warm or recovered, so a replica replaying from an older cursor learns of
every reveal. The Discard kernel refreshes the sources whose documents it tombstoned.

Every caller takes the §14 order before the first document lock here: in-process
leases, thread row, Work rows, the draft row (`FOR NO KEY UPDATE` to change or close
it, `FOR SHARE` to rely on it), namespace keys, document locks, then row locks.

[docs]: https://github.com/haowjy/meridian-flow-docs
