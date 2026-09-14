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
resource intentions before transport. Folder commands retain the direct context
mutation adapter. A failed file delete restores the row with a retry marker; a
failed placement reopens the identity field. Cache absence never supplies
removal evidence.

The project availability coordinator watches server-backed tabs, bound route
selection, retained sessions, and capped recent routes by stable file ID. Exact
delete receipts enter it directly; explicit authorization-loss observers and
focus, online, and bounded polling recheck watched identities. A catalog wake
for a cold Work triggers the same exact-ID availability path without warming a
second tree. Cache omission is presentation state and never removal evidence.
Generation-bearing final commands own the atomic tab, route, selection,
admission, working-set, and Yjs session effects; same-ID moves and local-new
tabs survive. Opening requires exact final availability plus a live opener and
admission.

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
`ContextEditorMountHost`. `EditorView` may bind that content without waiting for
first server sync. Server-only sessions retain the first-sync horizon, and local
readiness never claims remote acknowledgement; adoption and transport continue
in the background on the same Y.Doc.

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

Editor tree and tabs admit project documents only. Scratch/Uploads remain valid
storage and reference/tool schemes; direct resource URLs show an explicit
viewing-not-available state. Persisted resource tab entries are removed without
deleting resource documents or durable local content. The deferred chat-launched pane
overlay is recorded in [TODO](TODO.md); it is not a tab or a whole-app modal.

Eligibility is enforced at every live workspace transition, including
bootstrap, adoption and availability updates. Hiding a resource row alone is
insufficient: a hidden tab must not remain eligible for close fallback.

Every editable tab keeps `ContextTabSessionBoundary` as the same React ancestor.
Resource-backed tabs resolve through their stable resource handle before and after
acknowledgement, placement, and remint, so metadata changes do not remount the
editor. Close releases the content lease; warm-view eviction does not close
registry transport retained for the open tab set.

## Browser-local Editor workspace

Zustand owns live membership. Restore snapshots use sessionStorage under
`meridian:editor-workspace:v1`, isolated per browser tab/window and never
projected from storage events. Layout persistence failure is reported without
rejecting New/select/Close. Old shared desk keys are not read or written. Resource
metadata and content persistence remain separate from browser-tab workspace membership.
