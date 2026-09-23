# Editor document lifecycle

Document navigation has separate address, tab-publication, and content owners.
A pending address is not a reason to hide an already usable editor. Retention
is presentation continuity, not authorization for the requested document.

```mermaid
flowchart TD
  A[Document navigation] --> B[Resolve destination identity and authority]
  B --> C[Prepare tab and request shared leave decision]
  C --> D[Accept URL then commit workspace]
  D --> E[Document host binds existing or new session]
  E --> F[Render target content]
  B -. during same-Work pending navigation .-> G[Keep prior document and matching chrome visible]
```

## Entry paths

- **Editor navigation item:** once project workspace validation is live, choose the
  selected eligible open tab or a remembered identity that is still open. Use
  its current metadata, not its historical path. Navigate directly to it. Before
  workspace validation finishes, navigate to empty Editor without mutating persisted
  selection. No later mount effect restores a document or opens the first file.
- **Bare `/editor` without a local-document history pointer:** explicitly empty
  on direct entry, reload and Back/Forward. Empty means no tab is opened. The
  pane may offer this project's recently opened documents as a chooser. It paints
  the device record, including after reload, and does not wait for the server
  list. Choosing navigates, and entry itself still opens nothing.
  Closing every tab and switching screens cannot reopen a closed identity.
- **Tab-strip chooser control:** clear the document address and any local-document
  history pointer, and leave the working set alone. A local draft is already
  `/editor`; the pointer is what selects it. Not the Editor navigation item: it
  resolves no remembered identity and opens no tab, so the pane it lands on stays
  empty. Clicking a tab returns. Back returns to the document that was showing.

- **Readable URL, reload, Back/Forward:** `ReadableProjectRoute` resolves the
  project and document address. `ProjectAddressDocument` uses the authorized
  result's catalog entry to publish tab metadata. It does not invoke a second
  live opener. While a lookup is refetching, cached metadata cannot publish
  an admission or repair the URL.
- **Stable document ID, such as a wikilink or search result:**
  `ProjectDocumentNavigationAdapter` opens known exact initialized content through
  the resource owner; unacquired content uses the live opener. It passes prepared
  tab metadata to the route owner. Accepted history commits the tab and
  selection; a cancelled decision publishes neither. A background open publishes
  the tab without navigating or cancelling a foreground attempt. Scratch/Uploads resources are not Editor
  tabs: their resolved URLs show the deferred chat-resource viewing notice.
  The URL layer still does not repeat
  live admission; session binding belongs to the host.
- **New or pending local Unfiled writing:** an exact local identity in `/editor`
  history state selects the durable resource/session. New is available without
  a Work; the first content change starts project-owned `unfiled://` creation.
  Closed pending writing can be reopened from Unfiled, independently of tabs.
  Acknowledgement or remint preserves the resource handle and editor session while the address adopts the current Document ID.
  See [local writing ownership](../context/.context/resource-catalog-and-editor-lifecycle.md#unfiled-materialization-and-recovery)
  for remint, queued filing, and recovery constraints.

## Ordered handoff

1. Capture the navigation's ownership ticket or latest-attempt predicate.
2. Resolve the requested document and its scope. A path is a reusable address;
   the returned document ID is identity.
3. Claim the application navigation intent before cancelling any older decision.
   The history-owned restoration barrier retires pending native traversals and
   returns the browser to its accepted entry. Its settled fast path is synchronous.
4. Ask the shared Work metadata guard. After permission and any restoration,
   revalidate the operation, caller lifetime and existing member instance.
   Snapshot the displayed departure and dispatch the destination as one ordered
   operation. Do not await route loaders as proof that navigation was accepted.
5. On the matching history notification, flush the native URL, then synchronously
   install/select the prepared tab or commit Close's successor/empty workspace.
   Snapshot persistence failure is observable; it does not roll back the live
   workspace. Delayed Close cannot remove a reopened member instance.
6. A cold readable address is already accepted before `ProjectAddressDocument`
   publishes its authorized metadata. Alias replacement remains pending until
   canonical navigation settles; only a current failure may expose an error.
7. The document host owns content startup and session binding. Finishing
   address admission does not prove that a cold document's content is ready.

The availability coordinator joins simultaneous explicit opens of one identity.
Each lookup holds its own document watch until settlement, independently of
a departing view's watch. Neither tab cleanup nor another identical opener can
invalidate that caller merely by replacing its request generation.

## Native history ownership

The scoped `@tanstack/history` patch owns traversal epochs and restoration.
Returning to the accepted key/index retires stale decisions without `go(0)`.
A cancelled traversal and a superseding application intent share one restoration;
unexpected native movement or destruction resolves it as superseded. Application
navigation waits for restoration before writing its departure snapshot and
destination. It never repairs the browser with a second URL normalizer.

The route's shared guard owns Save/Discard/Keep editing. Retiring a decision
dismisses the dialog without clearing the draft. Native Back/Forward uses the
same decision owner; Settings remains its existing routed overlay.

## What stays visible

For a same-project, same-Work Editor transition with prior usable content,
`ProjectRouteBoundary` leaves that content visible and non-inert, without a
spinner or loading label. Desktop surfaces remain mounted; returning to a warm
document can reuse its editor and session.

Phone retention keeps the old document's path, identity, and breadcrumb
presentation together. `HydratedReviewScopes` supplies that same identity to
both recovery and the phone document host. Navigation commands remain current,
so clicking the retained Files breadcrumb can supersede the pending open.
Retention does not change the phone viewer's existing read-only behavior.

Retention ends when the new address is admitted or the transition is no longer
eligible. Cold address entry keeps the shell and pane geometry, with hidden/inert pending
content. The pane stays blank for approximately 500ms, then shows a skeleton if
still pending. Only that fallback is keyed by the destination; the editor is
never keyed or remounted for loading. Settlement removes feedback immediately,
with no minimum display duration. Busy state is exposed without loading copy.
Different-project entry, Work recovery, unavailable destinations, and errors do
not expose retained content as if it were the requested destination. A cold
content host may also need its own startup UI after address resolution.

## Session and synchronization boundary

This route lifecycle uses the existing session registry and Yjs/IndexedDB
persistence. It adds neither a second content cache nor a sync-based read-only
gate. Warm navigation can reuse a live session and connection. A new session
has its own local-replay and transport-startup lifecycle; address admission
must not be confused with local persistence readiness or server reconciliation.
See the [editor core contract](../../../core/editor/.context/CONTEXT.md).
The basic editor module loads with the project hosts, so first local New does
not require a dynamic import after the loaded workspace goes offline. Persistent
root/auth/project loaders do not refetch on same-shell navigation; explicit
invalidation and new entries still acquire authority. Cold offline app boot
remains unsupported.

Transport remains room-scoped; multiplexing is outside this routing contract.

## Source and checks

- [Address admission](../routing/ProjectAddressDocument.tsx) and its sibling tests.
- [Navigation ownership](../routing/project-navigation.ts) and its sibling tests.
- [Stable-ID navigation](../context/open-project-document.ts).
- [Loading boundary](../routing/ProjectRouteBoundary.tsx) and its sibling tests.
- [Shell and phone retention](../ProjectView.tsx).
- [Workspace transitions and restoration codec](../../../client/stores/context-tabs-store/editor-workspace-state.ts).
