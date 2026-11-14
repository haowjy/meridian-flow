# Presented documents and Editor lifecycle

Reference detail for how the Editor presents documents in this browser tab: hosts, removal
notices and draft-only presentation. Read
[CONTEXT.md](CONTEXT.md) for the feature-level contracts first.

## Tree projection

Every tree, picker and reference browser projects from the project's replay (`useProjectTreeViews`,
`useProjectTrees`; see [CONTEXT.md](CONTEXT.md), Tree ownership). There is no second copy of
placement and no catalog to acquire: a create, rename, move or delete the writer makes shows in
every view at once, and an offline one stays in the copy until the connection returns.

Whether a document is still there is the project's list's answer, not a lookup: `ProjectStandings`
reads the list's replay for a document and says it is in the tree, in Trash, purged, not in the
list, or waiting for the list (an absence is not an answer until the list has been read). The
removal observer (`list-removal-observer.ts`), the removed notice and the editor's own banner all
read it, so nothing is polled and nothing is stamped with a generation. A document that leaves the
live tree closes its views and leaves the recent routes; one that comes back is let back. The
removal's effect on views, notices and recent routes is applied by
`ContextRemovalCoordinator.applyRemovals`; the route follows the replay itself.

`useFileSuggestions` projects directly from the normalized scope views. It
never walks or caches a second recursive tree and never adds a server-search path; hosts constrain
schemes and file/directory kinds, then mount the presentation-only list.

Desktop scheme/query orchestration lives in `ContextTreePanel`; `ContextTreeRows`
selects each expanded row's direct children by stable parent ID through one
scheme-scoped environment. Mobile renders one level at a time via route params.

## Presented documents

The writer-facing destination is **Editor**. `ContextRemovalCoordinator` owns
the effect of a removal on presented documents, notices and recent routes from what the list says;
route continuity is the route's (the history entry's remembered id, `ReadableProjectRoute`). `AccountResourceReplica` independently owns resource and
content durability. Neither owns the other's state.

New appends a provisional `create` in Unfiled and opens the node by the name the replay gives
it, before the server has heard of it; its text room connects once the create is admitted and is
retried while it is not (`4211`). Leaving main removes only browser-local presentation. It never
deletes the document.

Nothing persists open documents: main shows the document its address names, the side shows
the project's current chat or document, and the newest document shown that is off screen stays mounted
hidden (`kept`) until a close, a Discard or a removal forgets it. Each browser tab/window presents independently. Accepted navigation commits browser history in one prepared operation.
Returning to an empty Editor does not restore a closed document.

`OpenDocumentSessionBoundary` opens the ordinary live binding (`useLiveDocumentBinding`: open,
bind, explicit retry). `ProjectDocumentLiveOpener.open` asks the list's standing for the document
(`ProjectStandings`), so a document made here, before the server has heard of it, opens at once:
the session paints from the browser's local copy and its room connects when the server has the
`create` (the room closes non-terminally, `4211`, until then). The binding presents the live
session in place of the cached one, and shows the session's own connection state. A failed binding
offers Retry; the phone's document host (`DocumentHost`, phone presentation) uses the same binding.

A draft-only document (a new document proposed in a branch, or one live deleted
while a Work's draft still has it) opens no live binding at
all: it is absent from the live SQL tree and the server refuses a room for it,
so review hosts the draft room alone (`liveRoom` only when `useDraftOnlyPresentation`
answers `live`) and a failed draft room offers Retry or closing the document, never a
fallback to an empty live editor. Draft-only is a property of the mounted host (or a live delete's hold), not of
the document's descriptor: the evidence is the draft the document's view pins (its row says `isNew` or
`deletedLive`), and every way of opening a draft-created document pins its draft. The
host presents the document in `DraftOnlyPresentations` under a token minted per mount
and stays draft-only until settlement promotes it, so a Discard never flips it to a live
room the server refuses. The phone hosts it through the same `DocumentHost`, so a phone
mount presents in the registry like a desktop one. Both shells find the document through
`route-document-owner.ts`: the bound identity in the live tree, then the document the
answered address names (`addressedDocument`, built from the address's draft row when
live lacks it), before any path occupant. A plain path never settles on a draft-only
document; only its address with `owner` and
`item` reaches it.
Once live has the document (Apply, or a restore), settlement promotes the presentation
and this host opens its live room like any other document. Whether that open is
slow, fails, or disconnects is the host's business and never changes whether
Apply completed.

## Editor versus chat resources

Editor trees list project document schemes, plus the picked named Work's
Scratch as a sidebar source. Scratch documents open in main from there, from
links and from a chat's Files menu, owned by their Work or, for a No Work chat,
by their lineage; a Scratch crumb links nowhere. Uploads remain storage and
reference/tool resources; their direct URLs show the viewing-not-available state.

Eligibility is enforced at live transitions, including bootstrap,
adoption and availability updates. Hiding a row alone must not leave an
ineligible document available.

A removed document empties its view and nothing else moves. Neither the
planner nor the coordinator picks a neighbouring document or repairs the address: a trash,
a lost access or a document that was never there leaves the address as written, and
the route says "unavailable" there. The address lookup is cached, and an answer from
before the removal would present the document again (the removal would close it at once, in
a loop). So when the coordinator commits a removal it rewrites every cached answer naming the
document to "unavailable" (`AddressAnswersPort`, wired to the query cache in
`account-feature-lifetime.ts`), and a document becoming available again, Trash's restore and a
restored Work (Undo of a Work delete) invalidate the lookups, so a restore returns the document
at the same address. A document a draft still holds (a host presents it draft-only, or a
pinned draft is bound to it) is left out of the rewrite: a draft held over a document deleted
live keeps painting, and admission has nothing to install for it. A chapter the writer
deleted while its draft was under review opens as the draft from its review address, whose
answer the server gives afresh.

Every editable document keeps `OpenDocumentSessionBoundary` as the same React ancestor, so a
rename or move (the replay changing) does not remount the editor. Close releases the content
lease; a host leaving the screen does not close registry transport retained for the presented
documents.

## Tree observation

Composite UI consumers use `useProjectTreeViews` once for their scheme set. It cuts the session's
replay to each scheme's source, so a view is rebuilt when the list's version changes and not for
unrelated renders. The Editor sidebar derives its schemes from the project and account lists; link
suggestions derive six, including the current Work/no-Work scope. Collapsed sidebar sections stay
mounted.

### Removed-document notices

A presented document that something else deleted or discarded closes as
before and says so. Three owners, one concept each:

- **The list's standing.** `ProjectStandings.standing(projectId, documentId)` reads the replay of
  the project's list (and the account's, for `user://`): `in-tree`, `in-trash` (with who deleted
  it, from the delete record's actor), `purged`, `not-in-list`, or `waiting` until the list has
  been read. Nothing is polled and nothing is stamped. `useRemovalRecord` is the React reader: the
  notice, `SyncStatus`, the review room owner and the reopened review address.
- **The observer.** `observeListRemovals` (`list-removal-observer.ts`, mounted per project by
  `ProjectContextRemovalController`) watches the documents the app holds (views, recent routes,
  retained sessions) and applies what the list says as one batch through
  `ContextRemovalCoordinator.applyRemovals`: a document in Trash or purged closes its views and
  leaves the recents, one back in the tree is let back, and when main shows a document that went
  to Trash main opens its Trash view (who deleted it, Restore). A purged document's local copy is
  deleted, and so is the copy of a document whose source ended (Work or chat deleted; an archived
  Work's source stays) or whose project the account lost (`denied`).
- **The notice store.** `RemovedNoticeStore` holds one notice per project. The observer's closes
  push the documents that vanished; an entry shows once the list says it was removed.
- **The sentence.** `removalSentence` in `RemovedDocumentNotice.tsx` owns
  every copy rule as plain strings, so tooltips reuse them. A removal names
  its actor from the record, the same for every account, and never says "you":
  "Ana Ruiz deleted <title>.", "<title> was deleted with the Work <name>."; a
  system rollback reads "removed when the reply that created it didn't
  finish"; a user with no display name or a purged actor, "<title> was
  deleted."

Placement follows "feedback never displaces content": a chip in main's header
(`RemovedDocumentChip` in a `RemovedNoticeSlot`), the landing's top margin when main shows no
document, and the phone top bar's notice row. The slot keeps room for the chip's short sentence
("1 document deleted").

`useRemovedNoticeLifetime` (`ProjectView`, both shells) starts a notice's lifetime when it is on
screen, anchored where it first shows (a removal leaves the address on the removed document, so
that address); the next navigation in main clears the notice, documents still waiting for an
answer included. A removal joining the notice re-anchors it.

The writer's own removal says nothing: the tree delete and a Discard of a
created (draft-only) document begin through the removal coordinator
(`beginOwnRemoval`), which takes a mark in the store (`markOwnRemoval`)
before the request; the caller settles it in `finally`. If main shows one of
the removed documents, `beginOwnRemoval` also sends main back at once, before
the removal lands: to the document main showed before it, read from Recently
opened (this browser's record, merged with other devices' opens from the
server; the entry after it in opening order that still exists and is not
being removed; a draft-only page is never recorded, so main never goes back
to one), else to Recently opened itself (the bare Editor). The open replaces
the history entry, so Back skips the removed document. A removal by someone
else, from another device, or a remote Discard keeps the address on the
removed document. Neither the tree delete nor a created document's Discard
has an Undo; a restore from Trash never moves main. A Discard of an existing
document's edits removes nothing, so it marks nothing. Only documents a host
presents are marked. While the
mark lives every sighting is silent; "kept" releases it, and a settled
removal lasts until each host that presented the document saw it vanish or its removal
landed (`ownRemovalEnded`). A delete the server refuses after the list took it never
lands: the row comes back with its failure mark, and the marks of the refused entry's documents
end with it (the observer that did this is gone; step 6b reads it from the replay). Discard is a server command, not a record the browser writes.

A document in Trash still takes text: the live room admits it until its node is purged and
closes (`4208`) at the purge. Typing into a document someone else deleted is saved into it, and a
restore brings it back. A host still open on a purged room says the record sentence, or "Access
lost (not saving to the server)" when the list does not say why (`SyncStatus`). Draft rooms carry
no document identity in the registry, so their review owner closes and rebuilds them itself.

Reopening a review address whose document was removed says the sentence in
place of "This destination is unavailable" (item key parsed by
`@meridian/contracts`' `parseDraftItemKey`). A plain path address keeps "This
destination is unavailable": once nothing lives at the path it names no
document, and finding the newest tombstone at a path belongs to a later track.

Unsent text is kept: a delete closes the view, but the session and its local copy stay until the
unsent edits are acknowledged; only a purge, an ended source, a lost project or sign-out deletes the
copy (`local-document-copies.ts`).

### Multi-Work review representations

A presented document carries no review state.
Which draft a document shows is its view's pin; whether live lacks it is
`DraftOnlyPresentations` (`features/draft-review/draft-only-presentations.ts`). Two things
present a document there: a host mount, under a token minted per mount, and a live delete's
hold, one entry per held draft. Settlement (`DraftOnlySettlement`) settles both the same way,
so neither can outlive what it stands for: it promotes on the replay's evidence checked against a
fresh read, and ends a presentation only on that presentation's own answer, when its
draft's metadata says `gone` or the document's view no longer pins it (a Discard of the last
change leaves the draft active and empty). An ended document moves to the scope's draft of it
when there is one (the view's pin, and main's address with it), and closes otherwise.

One document has at most one host. When live deletes a document, the removal
coordinator asks which drafts of it some surface holds open (`boundDrafts`, never the review
list, which lags about a second) and keeps only the one the document's view pins: a draft held
open but not shown paints nothing. It records a hold for that draft (`holdRemovedLive`); the
removal plan leaves held documents alone (`held`) and ends the rest. The hold ends when
the coordinator commits an `available` command for the document (a restore, an Apply that
brought it back) or when its draft ends. Promotion back to live otherwise needs the document
in the live tree: the standing says `in-tree` once the replay places it, and the replay keeps a
deleted document's node in Trash, so knowing the id alone is not "live again". Restoring a saved review already queries the saved review Work and matches
both draft and document within that list.
