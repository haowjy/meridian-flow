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
tabs survive. Known exact initialized content opens through the resource owner before remote
admission. Unacquired content requires exact final availability and the live
opener. Verified-local readiness bypasses the first-sync wait, not upload
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

A tab that loses its resource handle but keeps its document (a review launch
re-opens it without one) keeps painting its cached session while the exact
lookup re-probes; the boundary never drops to a skeleton for that identity flip.

The desktop `ContextTabSessionBoundary` opens the ordinary live binding once its
local session has been probed (`useLiveDocumentBinding`: open, bind, explicit
retry). It presents the live session in place of the cached one when that
binding opens, and shows the session's own connection state. An availability
recheck that returns terminal, deleted, or schema-mismatch releases the cached
handle and its resource ownership lease rather than leaving the stale session
mounted. A local cache-open failure falls through to exact server availability
instead of terminalizing the tab from stale metadata. A failed binding offers
Retry and also retries once each time the resource availability revision
advances. The phone document host (`MobileDocumentHost`) uses the same binding
but neither offers Retry nor retries on a revision change, so a failed phone
open has no in-place recovery yet.

A draft-only tab (a new document proposed in a branch) opens no live binding at
all: it is absent from the live SQL tree and the server refuses a room for it,
so review hosts the draft room alone (`liveRoom={!draftOnly}`) and a
failed draft room offers Retry or closing the tab, never a fallback to an empty
live editor. The phone hosts it through the same `ContextEditorMountHost`
(`MobileDraftOnlyDocumentHost`), never its live-acquiring server host; both
shells find the tab through `route-document-owner.ts`, the bound identity in the
live catalog and then the draft-only admission before any path occupant.
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

A tab whose document something else deleted or discarded closes as before and
says so. `ContextRemovalCoordinator` owns one `notice` per project snapshot:
the `DocumentRemovalRecord`s of the documents that closed, joined into one
notice until the writer moves on. `RemovedDocumentSentence` owns every copy
rule (projects are single-owner, so a user actor matching the signed-in
account reads "You deleted <title> elsewhere."; another named user, "<title>
was deleted by <name>."; a system rollback, "removed when the reply that
created it didn't finish"; anything else, "<title> was deleted."). A Work's
removal keeps its authority-loss handling and makes no notice.

Placement follows "feedback never displaces content": a ghost chip in the tab
strip's free end (`RemovedDocumentTabNotice`), the landing's top margin when
no tab remains (`RemovedDocumentLandingNotice`), or the phone top bar's notice
row (`useRemovedDocumentPhoneNotice`). The chip sits outside the tab scroller
and takes only the width the tabs leave, truncating down to its glyph and
dismiss. It clears on dismiss, and on the writer's next navigation in the
Editor (`useRemovedNoticeLifetime`, mounted once in `ProjectView` for both
shells): each removed document keeps the address its tab showed; the notice
anchors on the Editor's place once the route has left those addresses (so the
removal's own fallback is not a navigation), and any later change of place,
including a phone folder browse, clears it. A removal joining the notice
re-anchors it.

Two paths feed it. An availability `terminal-remove` that closes tabs carries
the server's record. The catalog dropping a tab's document (`closeVanished`,
which also covers another browser tab's delete arriving through the shared
local replica before the server commits) and a draft-only tab leaving its
draft list (`discardDraft`) learn no record: the document joins
`awaitingRecordIds`, which the project view watches (`removal-records`) and
rechecks once; focus, `online` and the 60 s poll retry. Any command carrying
the record settles it into the notice, an authority loss settles it silently,
and the catalog placing the document again releases it.

The tab's own removal says nothing: the tree delete and every Discard take a
mark (`markOwnRemoval`) before the request and settle it in `finally`. A
settled "kept" releases it; while in flight every sighting is silent; once
settled as a removal, the first sighting uses it up. Folder deletes mark only
open tabs of the folder's scheme and owner.

A live room's 4208 has one reaction: `AccountFeatureLifetime` hears it from
the registry (`observeRemovedRooms`, held by an editor or not) and asks
availability for the document. `deleted` closes its tabs with the record.
`available` (a restore won the race, or a stale close) reconnects the same
session in place (`restartRemovedRoom`), once per session so a server that
keeps closing it cannot loop. Rebinding the tab instead would not help: its
cached resource handle hands back the same removed session. Editors read the
same answer (`useRemovedRoomCheck`, joining the in-flight lookup): a tab still
open on a removed room says the record sentence in place (`SyncStatus`).
Draft rooms carry no document identity in the registry, so their review owner
asks through the same hook and refreshes the Work's drafts.

Reopening a review address whose document was removed says the sentence in
place of "This destination is unavailable" (`useRemovedDestination`, item key
parsed by `@meridian/contracts`' `parseDraftItemKey`). A plain path address
keeps "This destination is unavailable": once nothing lives at the path it
names no document, and finding the newest tombstone at a path belongs to a
later track.

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
document) is that tab with review metadata; persistence skips it and selection names
the document. `editorTabsForWork` projects one Work's strip. Applying the draft
settles the same tab in place; a join re-identifies the resource's tab to the draft's
document and absorbs the draft-only tab into it. Dock restoration already queries the saved review Work and matches
both draft and document within that list.
