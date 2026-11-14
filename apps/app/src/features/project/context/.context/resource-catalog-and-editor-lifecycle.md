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
exact removal batch, on the route, selection, working set and views, is planned once
(`context-removal-batch-planner.ts`) and applied by `ContextRemovalCoordinator.applyRemovals`.

`useFileSuggestions` projects directly from the normalized scope views. It
never walks or caches a second recursive tree and never adds a server-search path; hosts constrain
schemes and file/directory kinds, then mount the presentation-only list.

Desktop scheme/query orchestration lives in `ContextTreePanel`; `ContextTreeRows`
selects each expanded row's direct children by stable parent ID through one
scheme-scoped environment. Mobile renders one level at a time via route params.

## Presented documents

The writer-facing destination is **Editor**. `ContextRemovalCoordinator` owns
removal of presented documents, route continuity and Work pruning from what the list says. `AccountResourceReplica` independently owns resource and
content durability. Neither owns the other's state.

New appends a provisional `create` in Unfiled and opens the node by the name the replay gives
it, before the server has heard of it; its text room connects once the create is admitted and is
retried while it is not (`4211`). Leaving main removes only browser-local presentation. It never
deletes the document.

Nothing persists open documents: main shows the document its address names, the side shows
the project's current chat or document, and the newest document shown that is off screen stays mounted
hidden (`kept`) until a close, a Discard or a removal forgets it. Each browser tab/window presents independently. Accepted navigation commits browser history in one prepared operation.
Returning to an empty Editor does not restore a closed document.

`OpenDocumentSessionBoundary` opens the ordinary live binding once its local
session has been probed (`useLiveDocumentBinding`: open, bind, explicit retry).
It takes a navigation lookup answer only when the answer was armed for its document;
local content winning discards that answer. It presents the live session in place of the cached one when that
binding opens, and shows the session's own connection state. An availability
recheck that returns terminal, deleted, or schema-mismatch releases the cached
handle and its resource ownership lease rather than leaving the stale session
mounted. A local cache-open failure falls through to exact server availability
instead of terminalizing the document from stale metadata. A failed binding offers
Retry and also retries once each time the resource availability revision
advances. The phone's document host (`DocumentHost`, phone presentation) uses the same binding
and recovery behavior.

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

- **The record cache.** `ProjectContextAvailabilityCoordinator.removalRecord(projectId,
  documentId)` is a subscribable per-document answer: `removed` with the
  server's `DocumentRemovalRecord` (null: the server keeps none, because the
  source or Work went rather than the document itself), `available`, `lost`
  (an authority loss) or `unresolved` (the lookup failed). Every resolution
  fills it, whichever watch, open or poll brought it, before its commands
  apply. Subscribing asks: the first subscriber looks the document up unless
  an answer or an open is pending, and the document stays watched (focus,
  `online`, the 60 s poll) until it is `removed` or `lost`. `available` is not
  final while someone asks: another browser tab's delete reaches this tab
  through the replay before the server commits it.
  `useRemovalRecord` is the one React reader: the notice, `SyncStatus`, the
  review room owner and the reopened review address.
- **The notice store.** `RemovedNoticeStore` holds one notice per project. Whatever
  presented a document pushes it when it vanished: `ContextRemovalCoordinator`
  (`closeVanished`, a `terminal-remove` that ended a presentation, `discardDraft`) and
  `useFollowOpenDocumentPlacement` (a presented document the replay no longer places). An entry
  shows once the cache says `removed`; a Work's removal and an authority loss drop it. The store
  asks `PresentedDocuments.isPresented` which documents a view still shows.
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

A live room's 4208 has one reaction: `AccountFeatureLifetime` hears it from
the registry (`observeRemovedRooms`, held by an editor or not) and follows the
document's answer in the record cache. The close outdates any answer but
`removed` (`roomRemoved` forgets it and asks again), so whatever answers next
was learned after the close. `removed` ends its presentations. `available` (a restore
won the race, or a stale close) reconnects the same session in place
(`restartRemovedRoom`). Each close costs one lookup and at most one restart;
nothing caps restarts across closes, which holds because the server's 4208 and
availability read the same removal record. A real restore cycle never leaves
the document dead. The follow ends on `removed`, `lost`, the restart
or the session's end; a failed lookup leaves it `unresolved` and the
availability watch keeps asking. Rebinding the document instead would not help:
its cached session hands back the same removed session. A host still
open on a removed room says nothing while asked, the record sentence for
`removed`, and "Access lost (not saving to the server)" otherwise
(`SyncStatus`). Draft rooms carry no document identity in the registry, so
their review owner does the same itself: it forgets the answer on the close,
refreshes the Work's drafts on `removed` and rebuilds the room on `available`.

Reopening a review address whose document was removed says the sentence in
place of "This destination is unavailable" (item key parsed by
`@meridian/contracts`' `parseDraftItemKey`). A plain path address keeps "This
destination is unavailable": once nothing lives at the path it names no
document, and finding the newest tombstone at a path belongs to a later track.

Unsent text is not kept: a removed document's presentation ends even when its
session holds unacknowledged edits. Keeping it bound would need more than the
planner deferring this document's removal and revoke: the vanished-from-the-replay close
must defer too, and the route's path-based admission stops resolving the address
(masking the document as unavailable and dropping its selection to a candidate).

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
placed in the live tree: the replay keeps a deleted document's node, and knowing the id alone
is not "live again". Availability applies a delete before the replay hears of it, so while
availability answers `removed` a placed node asks availability to look again
(`removalOutdated`): the answer turns `unresolved` and availability's own watch retries a failed
lookup on focus, online and the poll. Settlement follows that answer and promotes only on
`available`. Restoring a saved review already queries the saved review Work and matches
both draft and document within that list.
