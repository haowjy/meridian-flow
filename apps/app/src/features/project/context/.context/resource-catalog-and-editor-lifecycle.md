# Resource catalog and Editor lifecycle

Reference detail for the account resource replica, local resource-backed Editor
sessions, and the documents this browser tab presents. Read
[CONTEXT.md](CONTEXT.md) for the feature-level contracts first.

## Catalog acquisition and tree projection

`AccountResourceReplica` serializes compact catalog snapshots and whole-commit
deltas into durable checkpoints. React Query triggers acquisition and delivers
results, while every tree, picker, and reference browser
projects from the same replica state. Applied revision advances only through
contiguous whole commits; observed head may lead while a bounded replay has more
pages. Local resource locations overlay server checkpoints by stable resource
identity and remain visible across offline reloads.

The browser replica does not exist during server rendering. Catalog hooks use
the optional account context and React Query `skipToken` until hydration installs
that one owner; SSR renders the stable shell without issuing an HTTP fallback or
constructing a second catalog hierarchy. Once live, the project-level catalog
wake subscription sends truth-free head hints to the replica. Mount, focus,
periodic refresh, and wake hints schedule background acquisition through the same
serialized owner.

Editable-file create, rename, move, and delete commands write ordered durable
resource intentions before transport. Folder placement and recursive deletion
share that journal; folder creation retains the direct context mutation adapter. Rejected deletion restores the row with repair state; transport
uncertainty leaves the submitted attempt recoverable. Rejected placement
reopens the identity field. Cache absence never supplies
removal evidence.

The project availability coordinator watches presented documents (`PresentedDocuments`), bound route
selection, retained sessions, and capped recent routes by stable file ID.
Namespace receipt projections and explicit authorization-loss observers, plus
focus, online, and bounded polling recheck watched identities. A catalog wake
for a cold Work triggers the same exact-ID availability path without warming a
second tree. Cache omission is presentation state and never removal evidence.
Generation-bearing final commands own the atomic route, selection,
admission, working-set, and Yjs session effects; same-ID moves and local-new
documents survive. A door commits from catalog identity without inspecting content.
The installed host opens known exact content through the resource owner before
remote admission. Unacquired content requires exact final availability and the
live opener. Verified-local readiness bypasses the first-sync wait, not upload
authorization.

`useFileSuggestions` projects directly from the normalized scope views. It
never walks or caches a second recursive tree and never adds a server-search path; hosts constrain
schemes and file/directory kinds, then mount the presentation-only list.

Desktop scheme/query orchestration lives in `ContextTreePanel`; `ContextTreeRows`
selects each expanded row's direct children by stable parent ID through one
scheme-scoped environment. Mobile renders one level at a time via route params.

## Presented documents and local documents

The writer-facing destination is **Editor**. `ContextRemovalCoordinator` owns
removal of presented documents, route continuity, Work pruning, and generation-bearing
availability effects. `AccountResourceReplica` independently owns resource and
content durability. Neither owns the other's state.

New creates one initialized local resource and opens its exact Y.Doc before any
server request. The document's descriptor carries the resource handle immediately. Empty reserved
documents remain local and recoverable; first meaningful content or explicit
filing records the immutable create-eligibility witness and schedules the durable
namespace runner. A successful create transfers the same session into authorized
registry ownership. A create conflict remints the document ID while preserving
the resource handle, persistence database, Y.Doc, editor ancestry,
cursor, and undo history.

`contextTabFromResource` is the single optimistic descriptor projection. An unnamed
local resource (`materialization.unnamed`) is `new`; an explicitly filed local
resource immediately becomes a route-owning `tracked` document even while offline;
acknowledgement keeps it tracked, and from then on the catalog's `provisionalName`
says whether its name is still provisional. Projection reconciliation
targets the resource handle, so a delayed old document ID cannot replace a
reopened document. Leaving main removes only browser-local presentation. It never
deletes the durable resource.

Nothing persists open documents: main shows the document its address names, the side shows
the last chat or last document, and the last document that left main stays mounted hidden
(`kept`). Each browser tab/window presents independently. Project bootstrap keeps durable local
documents from the replica without remote availability admission; ordinary server documents still
use exact availability. Accepted navigation commits browser history in one prepared operation.
Returning to an empty Editor does not restore a closed document.

When the resource boundary returns an exact initialized local session, it also
returns verified-local readiness through `ContextTabSessionBoundary` and
`ContextDocumentHost`. `EditorView` may bind that content without waiting for
first server sync. Server-only sessions retain the first-sync horizon, and local
readiness never claims remote acknowledgement; adoption and transport continue
in the background on the same Y.Doc.

A cached session is adopted into the registry at the document's current
admission generation, which advances on any project mutation. Its persistence
incarnation keeps the generation it was captured at, exactly as a live `admit`
reuses it, so adoption must accept an older bindable incarnation (only a newer
one is a foreign lineage). Refusing it strands the cached session `detached`:
local edits never reach the server and the pill stays silent. When adoption
itself fails (authority unreachable or the handoff errors), the adopter reports
it to the session, which records the failure only while it is `detached` with no
transport. The snapshot's `adoptionStalled` is derived from that: true only
while `detached`, cleared by attaching a transport or a successful adoption,
and never alongside a terminal state. `SyncStatus` treats it as an outage
(see `core/editor/.context/CONTEXT.md`); elapsed detached time alone shows
nothing, because a session merely awaiting its transport is healthy.

A document that loses its resource handle but keeps its document (a review launch
re-opens it without one) keeps painting its cached session while the exact
lookup re-probes; the boundary never drops to a skeleton for that identity flip.

`ContextTabSessionBoundary` opens the ordinary live binding once its local
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
while a Work's draft still has it, D79) opens no live binding at
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
`route-document-owner.ts`: the bound identity in the live catalog, then the document the
answered address names (`addressedDocument`, built from the address's draft row when
live lacks it), before any path occupant. A plain path never settles on a draft-only
document (`resolveWorkspaceRoute`'s `isDraftOnly`); only its address with `owner` and
`item` reaches it.
The live resource replica says nothing about a draft-only document
(`projectResourceTab` answers `none`): a deleted document's replica record is
terminal, often from an earlier session's cache, and treating it as the document's
removal hid the editor behind a skeleton that never resolved.
Once live has the document (Apply, or a restore), settlement promotes the presentation
and this host opens its live room like any other document. Whether that open is
slow, fails, or disconnects is the host's business and never changes whether
Apply completed.

## Unfiled materialization and recovery

A new document is an account resource exposed to its creating project before it
has a server row. Reservation atomically records a stable handle, document ID,
exact persistence name, its untitled materialization, provisional Unfiled location,
and a first `set-location` placement whose eligibility is initially null. Local
persistence initialization completes before the editor receives the handle.

First content marks eligibility once. Explicit filing both marks eligibility and
appends a location intent. Dispatch sends a create while the record has no canonical
place and a move afterwards, so a refused first placement is repaired by placing it
again rather than by a different intent kind. The runner persists immutable request
bytes before HTTP, records outcomes before applying them, and resumes after response
loss or reload. Creation acknowledgement records canonical metadata and transfers the
same Y.Doc into registry transport. Leaving main leaves the resource in the
sidebar; explicit Delete is the only writer command that removes it.

A foreign-ID create conflict remints under the resource lock, cancels the old
unsubmitted dependents, and appends a retry plus rebased intentions for the new
identity. Aliases let every browser context update its existing detached session
without replacing its Y.Doc. Unknown or uninitialized local databases are never
opened as blank documents.

## Editor versus chat resources

Editor trees list project document schemes only. Scratch documents open in
main through links, Work Files and a chat's Scratch section, owned by their
Work or, for a No Work chat, by their lineage; nothing in the Editor browses
Scratch, and a Scratch crumb links nowhere. Uploads remain storage and
reference/tool resources; their direct URLs show the viewing-not-available state.

Eligibility is enforced at live transitions, including bootstrap,
adoption and availability updates. Hiding a row alone must not leave an
ineligible document available.

A removed document empties its view and nothing else moves. Neither the
planner nor the coordinator picks a neighbouring document or repairs the address: a trash,
a lost access or a document that was never there leaves the address as written, and
the route says "unavailable" there. `useAddressResultAfterRemoval` keeps the address
lookup's stale "available" answer from presenting the document again (the removal would
close it at once, in a loop) until a read after the removal and the replica's living
record say it is back, so a restore returns the document at the same address. A
document some host still presents is exempt: a draft held over a document deleted live
keeps painting, and admission has nothing to install for it.

Every editable document keeps `ContextTabSessionBoundary` as the same React ancestor.
Resource-backed documents resolve through their stable resource handle before and after
acknowledgement, placement, and remint, so metadata changes do not remount the
editor. Close releases the content lease; a host leaving the screen does not close
registry transport retained for the presented documents.

## Catalog observation

The account replica reconciles metadata revisions for its entire lifetime, even
without a mounted catalog consumer. Acquisition commits feed the existing shared
IndexedDB live query; acquisition does not reread the whole account afterward.

Composite UI consumers use `useContextCatalogViews` once for their scheme set.
The hook observes one resource projection and one React Query result per distinct
authority scope, then derives scheme views. The Editor sidebar derives four
schemes from Project and User scopes; link suggestions derive six, including the
current Work/no-Work scope.
Collapsed sidebar sections stay mounted. Local-only rows are visible but cannot prove
catalog completeness. Unchanged projection records retain their array identity
through unrelated React renders.

Mounting a catalog consumer respects the five-second query freshness window;
showing a retained editor does not force a fresh request. Stale mounts,
explicit refetch, wake hints, reconnect/focus, and interval polling still refresh
catalogs through the same replica owner.

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
  through the shared local replica before the server commits it.
  `useRemovalRecord` is the one React reader: the notice, `SyncStatus`, the
  review room owner and the reopened review address.
- **The notice store.** `RemovedNoticeStore` holds one notice per project. Whatever
  presented a document pushes it when it vanished: `ContextRemovalCoordinator`
  (`closeVanished`, a `terminal-remove` that ended a presentation, `discardDraft`) and
  `useFollowOpenDocumentPlacement` (a presented document the replica no longer places). An entry
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
created (draft-only) document take a mark in the store (`markOwnRemoval`)
before the request and settle it in `finally`. A Discard of an existing
document's edits removes nothing, so it marks nothing. Only documents a host
presents are marked. While the
mark lives every sighting is silent; "kept" releases it, and a settled
removal lasts until each host that presented the document saw it vanish.
A replica change origin cannot replace the marks: Discard is a server command,
not a replica mutation.

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
its cached resource handle hands back the same removed session. A host still
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
planner deferring this document's removal and revoke: the catalog-vanished close
must defer too, the route's path-based admission stops resolving the address
(masking the document as unavailable and dropping its selection to a candidate),
and the session binding re-probes when the replica marks the resource terminal.

### Multi-Work review representations

A presented document carries no review state.
Which draft a document shows is its view's pin; whether live lacks it is
`DraftOnlyPresentations` (`features/draft-review/draft-only-presentations.ts`). Two things
present a document there: a host mount, under a token minted per mount, and a live delete's
hold, one entry per held draft. Settlement (`DraftOnlySettlement`) settles both the same way,
so neither can outlive what it stands for: it promotes on catalog evidence checked against a
fresh catalog read, and ends a presentation only on that presentation's own answer, when its
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
placed in the live tree: the replica keeps a deleted document's record, and knowing the id alone
is not "live again". Availability applies a delete before the replica hears of it, so while
availability answers `removed` a placed record asks availability to look again
(`removalOutdated`): the answer turns `unresolved` and availability's own watch retries a failed
lookup on focus, online and the poll. Settlement follows that answer and promotes only on
`available`. A join re-identifies the resource's descriptor to the draft's
document. Restoring a saved review already queries the saved review Work and matches
both draft and document within that list.
