# Editor document lifecycle

Document navigation has separate address and content owners. Opening a document in main is one
navigation: the address names it, and main's host follows. Nothing is installed or selected. A
pending address is not a reason to hide a usable editor, and retention is presentation continuity,
not authorization for the requested document.

## Entry paths

- **Bare `/editor`:** explicitly empty on direct entry, reload and Back/Forward. Main shows the
  Recently opened landing, a chooser painted from the device record without waiting for the server
  list. Nothing reopens a document on its own.
- **Recently opened door** (main's header): clears the document address and leaves the working set alone.
- **Readable URL, reload, Back/Forward:** `ProjectAddressDocument` canonicalizes the address and
  publishes its admission issue from the replay's file (the server's entry for a review). It installs
  nothing and invokes no second live opener. Until the list has synced, an address publishes no
  admission and repairs no URL.
- **Stable document ID:** `ProjectDocumentNavigationAdapter` opens known initialized content through
  the resource owner and commits main's address. Every door opens in main, a chat's included. A
  cancelled decision publishes nothing.
- **Uploads** have no editor address. Every door opens one in `UploadViewerDialog`, not in main
  or the side.
- **A new document** is a node of the list at once, in Unfiled: its address is its placement, and
  the route is bound to its id, so a rename or a move repairs the URL to the same document.

## Ordered handoff

1. Capture the navigation's ownership ticket.
2. Resolve the requested document and its scope.
3. Claim the application navigation intent before cancelling any older decision. The history-owned
   restoration barrier retires pending native traversals and returns the browser to its accepted entry.
4. Ask the shared Work metadata guard. After permission and any restoration, revalidate the operation
   and caller lifetime, then dispatch the destination. Route loaders aren't proof that navigation was
   accepted.
5. On the matching history notification, flush the native URL and bind the route to the document the
   navigation named. Main's host then paints it.
6. A cold readable address is already accepted before `ProjectAddressDocument` publishes. Alias
   replacement stays pending until canonical navigation settles.
7. The document host owns content startup. Finishing address admission doesn't prove a cold document's
   content is ready.

The availability coordinator joins simultaneous opens of one identity. Each lookup holds its own document
watch until settlement, so another identical opener can't invalidate that caller by replacing its request
generation.

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
as if it were the requested destination. A masked destination leaves rails, the side and address navigation
usable. Phone mounts a document host only after admission or for a retained transition, so a masked
missing address can't repair itself to Files.

## Session boundary

This lifecycle adds neither a second content cache nor a sync-based read-only gate. Address admission isn't
local persistence readiness or server reconciliation; see the
[editor core contract](../../../core/editor/.context/CONTEXT.md).

## Review addresses

Only a route with `itemKey` and a resolved owner reads a Work's tree. It finds the item's document by id
in the tree of the branch the item's metadata names (`useDraftMetadata`), in any source, so a page the draft
created, renamed or moved opens where the Work puts it; a drafted delete is absent there and reads live. A
plain address stays live-only, and no caller guesses an item from a path or a Work's draft list.

`ReadableProjectRoute` keeps `useDraftMetadata` above editor address admission, so a list change can't
unmount the room first and strand the destination as unavailable. See the
[review runtime](../../draft-review/.context/draft-review.md).
