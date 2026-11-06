# Editor document lifecycle

Document navigation has separate address, tab-publication and content owners. A pending address is
not a reason to hide a usable editor, and retention is presentation continuity, not authorization for
the requested document.

## Entry paths

- **Editor navigation item:** once workspace validation is live, it goes to the selected open tab or a
  remembered identity still open, using current metadata, not its historical path. Before validation
  it goes to empty Editor without mutating persisted selection. No later mount effect restores a
  document or opens the first file.
- **Bare `/editor`:** explicitly empty on direct entry, reload and Back/Forward. The pane may offer
  recent documents as a chooser, painted from the device record without waiting for the server list.
  Closing every tab and switching screens can't reopen a closed identity.
- **Tab-strip chooser:** clears the document address and any local-document history pointer and leaves
  the working set alone. It resolves no remembered identity, unlike the navigation item.
- **Readable URL, reload, Back/Forward:** `ProjectAddressDocument` publishes tab metadata from the
  authorized catalog entry and invokes no second live opener. While a lookup is refetching, cached
  metadata can't publish an admission or repair the URL.
- **Stable document ID:** `ProjectDocumentNavigationAdapter` opens known initialized content through
  the resource owner and passes prepared tab metadata to the route owner. Accepted history commits the
  tab and selection; a cancelled decision publishes neither. A background open publishes the tab
  without navigating or cancelling a foreground attempt.
- **Uploads** aren't Editor tabs. The only viewer is the dock beside a centered chat, so Open on an
  upload is offered only there.
- **Pending local Unfiled writing:** an exact local identity in `/editor` history state selects the
  durable resource and session. Acknowledgement or remint preserves the resource handle and editor
  session while the address adopts the current Document ID. See
  [local writing ownership](../context/.context/resource-catalog-and-editor-lifecycle.md).

## Ordered handoff

1. Capture the navigation's ownership ticket.
2. Resolve the requested document and its scope.
3. Claim the application navigation intent before cancelling any older decision. The history-owned
   restoration barrier retires pending native traversals and returns the browser to its accepted entry.
4. Ask the shared Work metadata guard. After permission and any restoration, revalidate the operation,
   caller lifetime and existing member instance, then snapshot the departure and dispatch the
   destination as one ordered operation. Route loaders aren't proof that navigation was accepted.
5. On the matching history notification, flush the native URL, then synchronously install the prepared
   tab or commit Close's successor. Snapshot persistence failure is observable and doesn't roll back the
   live workspace.
6. A cold readable address is already accepted before `ProjectAddressDocument` publishes. Alias
   replacement stays pending until canonical navigation settles.
7. The document host owns content startup. Finishing address admission doesn't prove a cold document's
   content is ready.

The availability coordinator joins simultaneous opens of one identity. Each lookup holds its own document
watch until settlement, so tab cleanup or another identical opener can't invalidate that caller by
replacing its request generation.

## Native history

The scoped `@tanstack/history` patch owns traversal epochs and restoration. Returning to the accepted
key/index retires stale decisions without `go(0)`. Application navigation waits for restoration before
writing its departure snapshot and never repairs the browser with a second URL normalizer.

The route's shared guard owns Save/Discard/Keep editing. Retiring a decision dismisses the dialog without
clearing the draft.

## What stays visible

For a same-project, same-Work Editor transition with prior usable content, `ProjectRouteBoundary` leaves
that content visible and non-inert, with no spinner. Phone retention keeps the old document's path,
identity and breadcrumb together, and navigation commands stay current, so clicking the retained
breadcrumb can supersede the pending open.

Cold address entry keeps the shell and pane geometry with hidden, inert pending content. The pane stays
blank for about 500ms, then shows a skeleton. Only that fallback is keyed by the destination; the editor
is never keyed or remounted for loading. Settlement removes feedback immediately, with no minimum
display time.

Different-project entry, Work recovery, unavailable destinations and errors don't expose retained content
as if it were the requested destination. A masked destination leaves rails, dock and address navigation
usable. Phone mounts a document host only after admission or for a retained warm transition, so a masked
missing address can't repair itself to Files.

## Session boundary

This lifecycle adds neither a second content cache nor a sync-based read-only gate. Address admission isn't
local persistence readiness or server reconciliation; see the
[editor core contract](../../../core/editor/.context/CONTEXT.md).

## Review addresses

Only a route with `itemKey` and a resolved Work sends its Work and per-document draft selector, both in the
address query key. A plain manuscript address stays live-only, and no caller guesses a review selector from a
path or a Work's draft list.

`ReadableProjectRoute` keeps `useDraftMetadata` above editor address admission, so catalog invalidation can't
unmount the room first and strand the destination as unavailable. See the
[review runtime](../../draft-review/.context/draft-review.md).
