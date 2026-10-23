# Resource catalog and Editor lifecycle

Reference detail for the account resource replica, local resource-backed Editor
sessions, and browser-local Editor workspace. Read
[CONTEXT.md](CONTEXT.md) for the feature-level contracts first.

## Catalog acquisition and tree projection

`AccountResourceReplica` serializes compact catalog snapshots and whole-commit
deltas into durable checkpoints. React Query triggers acquisition and delivers
results, while every tree, picker, restored local tab, and reference browser
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

The project availability coordinator watches server-backed tabs, bound route
selection, retained sessions, and capped recent routes by stable file ID.
Namespace receipt projections and explicit authorization-loss observers, plus
focus, online, and bounded polling recheck watched identities. A catalog wake
for a cold Work triggers the same exact-ID availability path without warming a
second tree. Cache omission is presentation state and never removal evidence.
Generation-bearing final commands own the atomic tab, route, selection,
admission, working-set, and Yjs session effects; same-ID moves and local-new
tabs survive. A door commits from catalog identity without inspecting content.
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

## Editor tabs and local documents

The writer-facing destination is **Editor**. `ContextRemovalCoordinator` owns
workspace removal, route continuity, Work pruning, and generation-bearing
availability effects. `AccountResourceReplica` independently owns resource and
content durability. Neither owns the other's state.

New creates one initialized local resource and opens its exact Y.Doc before any
server request. The tab stores the resource handle immediately. Empty reserved
documents remain local and recoverable; first meaningful content or explicit
filing records the immutable create-eligibility witness and schedules the durable
namespace runner. A successful create transfers the same session into authorized
registry ownership. A create conflict remints the document ID while preserving
the resource handle, persistence database, Y.Doc, editor ancestry, tab instance,
cursor, and undo history.

`contextTabFromResource` is the single optimistic tab projection. An unnamed
local resource is `new`; an explicitly filed local resource immediately becomes
a route-owning `tracked` tab even while offline; acknowledgement keeps it tracked
and preserves whether its name is still provisional. Projection reconciliation
targets the resource handle, so a delayed old document ID cannot replace a
reopened member. Closing a tab removes only browser-local membership. It never
deletes the durable resource.

The browser-local Editor workspace persists membership, order, tab-instance IDs,
and one selection per Editor scope in sessionStorage. Each browser tab/window has
an independent workspace. Project bootstrap keeps durable local members from the replica
without remote availability admission; ordinary server members still use exact
availability. Accepted navigation commits browser history and workspace state in
one prepared operation. Returning to an empty Editor does not restore a closed
document.

When the resource boundary verifies an exact initialized local session, it
confirms that content on the session itself. `EditorView` binds only after the
session has confirmed content and settled local storage. Server-only sessions
confirm content at first sync; confirmation never claims remote acknowledgement.
Adoption and transport continue in the background on the same Y.Doc.

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

A tab that loses its resource handle but keeps its document (a review launch
re-opens it without one) keeps painting its cached session while the exact
lookup re-probes; the boundary never drops to a skeleton for that identity flip.

`ContextTabSessionBoundary` probes local content in parallel with the opener's
one attempt (`useLiveDocumentBinding`: open, bind, explicit retry). It takes the
attempt only when it was armed for its tab instance; local content winning
discards a pending answer, and an exact-local expectation that fails starts one
replacement request. It presents the live session in place of the cached one when that
binding opens, and shows the session's own connection state. An availability
recheck that returns terminal, deleted, or schema-mismatch releases the cached
handle and its resource ownership lease rather than leaving the stale session
mounted. A local cache-open failure falls through to exact server availability
instead of terminalizing the tab from stale metadata. A failed binding offers
Retry and also retries once each time the resource availability revision
advances. The phone document host (`MobileDocumentHost`) uses the same binding
and recovery behavior.

A draft-only tab (a new document proposed in a branch, or one live deleted
while a Work's draft still has it, D79) opens no live binding at
all: it is absent from the live SQL tree and the server refuses a room for it,
so review hosts the draft room alone (`liveRoom={!draftOnly}`) and a
failed draft room offers Retry or closing the tab, never a fallback to an empty
live editor. The phone hosts it through the same `ContextEditorMountHost`
(`MobileDraftOnlyDocumentHost`), never its live-acquiring server host; both
shells find the tab through `route-document-owner.ts`, the bound identity in the
live catalog and then the draft-only admission before any path occupant.
The live resource replica says nothing about a draft-only tab
(`projectResourceTab` answers `none`): a deleted document's replica record is
terminal, often from an earlier session's cache, and treating it as the tab's
removal hid the editor behind a skeleton that never resolved.
Once the server confirms Apply the tab is promoted to a durable tab
and this host opens its live room like any other document. Whether that open is
slow, fails, or disconnects is the host's business and never changes whether
Apply completed.

## Unfiled materialization and recovery

A new document is an account resource exposed to its creating project before it
has a server row. Reservation atomically records a stable handle, document ID,
exact persistence name, provisional Unfiled location, and a create intent whose
eligibility is initially null. Local persistence initialization completes before
the editor receives the handle.

First content marks eligibility once. Explicit filing both marks eligibility and
appends a location intent. The runner persists immutable request bytes before
HTTP, records outcomes before applying them, and resumes after response loss or
reload. Creation acknowledgement records canonical metadata and transfers the
same Y.Doc into registry transport. Closing every tab leaves the resource in the
sidebar; explicit Delete is the only writer command that removes it.

A foreign-ID create conflict remints under the resource lock, cancels the old
unsubmitted dependents, and appends a retry plus rebased intentions for the new
identity. Aliases let every browser context update its existing detached session
without replacing its Y.Doc. Unknown or uninitialized local databases are never
opened as blank documents.

## Editor versus chat resources

Editor trees list project document schemes only. Scratch documents open in
Editor tabs through links, Work Files and a chat's Scratch section, owned by their
Work or, for a No Work chat, by their lineage; nothing in the Editor browses
Scratch, and a Scratch crumb links nowhere. Uploads remain storage and
reference/tool resources; their direct URLs show the viewing-not-available state.

Eligibility is enforced at live workspace transitions, including bootstrap,
adoption and availability updates. Hiding a row alone must not leave an
ineligible tab available for close fallback.

Every editable tab keeps `ContextTabSessionBoundary` as the same React ancestor.
Resource-backed tabs resolve through their stable resource handle before and after
acknowledgement, placement, and remint, so metadata changes do not remount the
editor. Close releases the content lease; warm-view eviction does not close
registry transport retained for the open tab set.

## Browser-local Editor workspace

Zustand owns live membership. Restore snapshots use sessionStorage under
`meridian:editor-workspace:v1`, isolated per browser tab/window and never
projected from storage events. Layout persistence failure is reported without
rejecting New/select/Close. Resource metadata and content persistence remain
separate from browser-tab workspace membership.

## Catalog observation

The account replica reconciles metadata revisions for its entire lifetime, even
without a mounted catalog consumer. Acquisition commits feed the existing shared
IndexedDB live query; acquisition does not reread the whole account afterward.

Composite UI consumers use `useContextCatalogViews` once for their scheme set.
The hook observes one resource projection and one React Query result per distinct
authority scope, then derives scheme views. The Editor sidebar derives four
schemes from Project and User scopes; link suggestions derive six, including the
current Work/no-Work scope.
Collapsed sidebar sections stay warm. Local-only rows are visible but cannot prove
catalog completeness. Unchanged projection records retain their array identity
through unrelated React renders.

Mounting a catalog consumer respects the five-second query freshness window;
reactivating a retained editor does not force a fresh request. Stale mounts,
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
- **The notice store.** `RemovedNoticeStore` holds one notice per project and
  surface (`editor`: Editor tabs on both shells; `dock`: the dock's
  document). Whatever presented a document pushes it when it vanished:
  `ContextRemovalCoordinator` for Editor tabs (`closeVanished`, a
  `terminal-remove` that closed tabs, `discardDraft`), and
  `useDesktopDockPresentation` for the dock. An entry shows once the cache
  says `removed`; a Work's removal and an authority loss drop it.
- **The sentence.** `removalSentence` in `RemovedDocumentNotice.tsx` owns
  every copy rule as plain strings, so tooltips reuse them. A removal names
  its actor from the record, the same for every account, and never says "you":
  "Ana Ruiz deleted <title>.", "<title> was deleted with the Work <name>."; a
  system rollback reads "removed when the reply that created it didn't
  finish"; a user with no display name or a purged actor, "<title> was
  deleted."

Placement follows "feedback never displaces content": a chip in the tab
strip's free end (`RemovedDocumentChip` in a `RemovedNoticeSlot`), the
landing's top margin when no tab remains, the phone top bar's notice row, and
for the dock a chip beside "Recent" in Chat's rail header. The slot keeps room
for the chip's short sentence ("1 document deleted"), so tabs scroll before
the notice loses its words.

`useRemovedNoticeLifetime` (Editor: `ProjectView`, both shells; dock:
`DesktopProject`) starts a notice's lifetime only when its placement is on
screen (the Editor screen; Chat with its rail open and no dock document), so a
removal noticed elsewhere waits for the writer. It anchors once the place no
longer shows a removed document (the removal's own fallback is not a
navigation), and the next change of place clears the notice, documents still
waiting for an answer included. A removal joining the notice re-anchors it.
A dock removal on the Work screen has no placement there; it shows when the
writer next sees Chat's rail.

The tab's own removal says nothing: the tree delete and a Discard of a
created (draft-only) document take a mark in the store (`markOwnRemoval`)
before the request and settle it in `finally`. A Discard of an existing
document's edits removes nothing, so it marks nothing. Only documents a tab or
the dock presents are marked. While the
mark lives every sighting is silent; "kept" releases it, and a settled
removal lasts until each surface that presented the document saw it vanish.
A replica change origin cannot replace the marks: Discard is a server command,
not a replica mutation.

A live room's 4208 has one reaction: `AccountFeatureLifetime` hears it from
the registry (`observeRemovedRooms`, held by an editor or not) and follows the
document's answer in the record cache. The close outdates any answer but
`removed` (`roomRemoved` forgets it and asks again), so whatever answers next
was learned after the close. `removed` closes its tabs. `available` (a restore
won the race, or a stale close) reconnects the same session in place
(`restartRemovedRoom`). Each close costs one lookup and at most one restart;
nothing caps restarts across closes, which holds because the server's 4208 and
availability read the same removal record. A real restore cycle never leaves
the tab dead. The follow ends on `removed`, `lost`, the restart
or the session's end; a failed lookup leaves it `unresolved` and the
availability watch keeps asking. Rebinding the tab instead would not help:
its cached resource handle hands back the same removed session. A tab still
open on a removed room says nothing while asked, the record sentence for
`removed`, and "Access lost (not saving to the server)" otherwise
(`SyncStatus`). Draft rooms carry no document identity in the registry, so
their review owner does the same itself: it forgets the answer on the close,
refreshes the Work's drafts on `removed` and rebuilds the room on `available`.

The dock and the Editor share one push for a Discard that closes a created
document: `DraftOnlyContainer.remove` reports whichever container it closed
to that surface's notice.

Reopening a review address whose document was removed says the sentence in
place of "This destination is unavailable" (item key parsed by
`@meridian/contracts`' `parseDraftItemKey`). A plain path address keeps "This
destination is unavailable": once nothing lives at the path it names no
document, and finding the newest tombstone at a path belongs to a later track.

Unsent text is not kept: a removed document's tab closes even when its
session holds unacknowledged edits. Keeping it bound would need more than the
planner deferring this tab's removal and revoke: the catalog-vanished close
must defer too, the route's path-based admission stops resolving the address
(masking the tab as unavailable and dropping its selection to a candidate),
and the session binding re-probes when the replica marks the resource terminal.

### Multi-Work review representations

Review-only tabs are addressed by document, review Work and draft. A captured
mounted tab adds its instance ID and token; close, rename and Apply settlement
must retain that fence across asynchronous navigation. Document identity alone
is reserved for document-wide availability facts, not representation removal.
The removal coordinator remains the sole close/Discard owner.

The workspace holds one tab per document. A draft-only tab (a hidden draft-created
document, or a deleted one a Work's draft still has) is that tab with review metadata;
persistence skips it and selection names the document. When live deletes a document,
the removal coordinator first asks the draft command owner which drafts of it some
surface holds open (`boundDrafts`, never the review list, which lags about a second)
and turns each such tab into a draft-only tab for those Works (`keep-for-drafts`);
the removal plan then closes only the rest. Promotion back to an ordinary tab needs
the document placed in the live tree: the replica keeps a deleted document's record,
and knowing the id alone is not "live again". Availability applies a delete
before the replica hears of it, so while availability answers `removed` a placed
record is stale and promotes nothing (`DraftOnlySettlement`); otherwise the hold
was undone within the same second. `editorTabsForWork` projects one Work's strip. Applying the draft
settles the same tab in place; a join re-identifies the resource's tab to the draft's
document and absorbs the draft-only tab into it. Dock restoration already queries the saved review Work and matches
both draft and document within that list.
