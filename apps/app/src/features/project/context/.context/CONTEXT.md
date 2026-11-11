# features/project/context — contracts and architecture

Reference depth. Read the [AGENTS.md](../AGENTS.md) first.

## Link navigation versus editor admission

The ready Editor Work and Work-scoped documents carry their Work row id, including
No Work. Viewer reads and route matching use that ownership, never the host
Chat Work. Unresolved Editor Work cannot bootstrap Context or register a
removal host. Project-scoped files retain the Editor's Work context.

`ProjectDocumentNavigationAdapter` turns a known file identity into main's address before
content opens: every door opens in main. An ID absent from the in-memory resource projection
waits for one availability lookup; its available answer is consumed once by the destination.
The destination alone opens local content, admits the live room, and presents Retry. Read-only
Context files still open a viewer without live Yjs admission. Closing or replacing a
destination discards its unconsumed answer.
Scratch documents open in main owned by their resolved Work, or by their lineage
(`rootThreadId` and the handle its URI spells) when they are a No Work chat's notes.
Uploads have no editor address and open nowhere. The resolved file's
Work authority overrides the invoking surface's Work; only project-scoped
files retain host Work context. Never add upload-specific navigation in Composer.

The resource projection has explicit pending, ready, and failed states. A host
without a resource handle waits for the first ready snapshot; pending is never
treated as missing local content. A failed projection falls back to the
transactional identity lookup.

Availability command admission rejects while removal is suspended or disposed;
an empty successful receipt would let the availability owner falsely acknowledge
unapplied authority. Local settlement still differs from session-effect completion:
failed session effects remain pending for retry. This is not durable namespace
receipt recovery across account/authority shutdown.

## Account resource ownership

`AccountResourceReplica` is the sole browser owner for editable document
resources. It composes the account-qualified metadata database, serialized
catalog acquisition, namespace journal runner, exact local content access, and
same-session server adoption. `AccountFeatureLifetime` installs it before
project descendants and connects its two-phase close to the document-session
runtime. Account close fences new commands immediately, aborts transport work,
drains adoption/catalog/namespace operations, releases every retained session,
and closes metadata last.
Transient rename/move selection belongs to the account replica lifetime.
Remembering an operation starts its projection watch independently of any
mounted row. The latest matching intention supplies authority after rebase;
cancellation, refusal and deletion retire immediately. Successful settlement
leaves feedback until settlement plus four seconds, even
when no note is mounted; the watch ends at expiry or earlier terminal evidence. Account close disposes every selection and timer.
The authenticated provider boundary also re-scopes the client creation
registry, clearing transient Project creation records when the account
changes; Work command records (including creates) clear through the account's
abort signal in `work-command-store`. Neither is reload recovery.

The replica uses short account/resource Web Locks for namespace and terminal
coordination. Typing and ordinary local content access do not hold those locks.
A stable resource handle survives document-ID remint; the exact persistence name
and mounted Y.Doc do not change. The resource descriptor also retains the
catalog-defined file classification so cached code never reopens as rich text.

Availability becomes durable only through session authority for adopting or adopted
local-origin documents retaining their lineage; all other durable deletions require receipts.

## Visible Editor ownership

The address owns what main shows: `resolveMainDocument` finds its document by identity, then by
path, the same on desktop and phone. Main's tabs (`client/project-shell/main-tabs.ts`) follow the
address, never lead it: arriving at a document opens or selects its tab. Hosts mount their
documents in `PresentedDocuments` (`presented-documents.ts`: places main, side and kept). Its
`documents` are main's and the side's only (main first): the removal coordinator, availability
and removed notices read them to know what is on screen. Its `shown` list, every mounted document
newest on screen first, is where the desktop picks the kept host (an open tab only) and the side's
fallback; the coordinator's close, Discard and removal paths `forget` a document there, which also
closes its tab, so its host unmounts. One document has at most one host, keyed `document:<id>` (`DocumentHost.tsx`), so a move
between main and the side doesn't remount it.

## Architecture

```text
ContextTreePanel (desktop sidebar and the phone's drawer)
       ├─ useContextCatalogViews (batched projection)
       ├─ useCreateEntryForm
       ├─ useEntryInteraction
       │     └─ rename forms + move picker
       ├─ useDeleteContextEntry
       └─ ContextEntryActions (menus)
                     │
      useInlineEdit (components/ui, shared core)
                     │
          validateContextEntryName (pure)
```

Document trash is a server snapshot separate from the live catalog projection.
The tree doesn't read it: Trash is a sidebar source (`shell/sidebar/TrashSource.tsx`)
listing it newest first, and picking a row opens the routed `DocumentTrashDialog`,
which owns the list and the selected read-only record in one popup. Desktop keeps
the list and record side by side; phone shows the list or record, with Back to
return to the list. The detail reads the server's Markdown, serialized from the document's frozen Yjs, and composes
`ReadOnlyViewerFrame` with `TextViewer`; it never uses the live path-based read.
Stable-ID navigation confirms a deleted document through that endpoint before
opening the detail. List and detail restore through one command using the exact
serialized removal identity. Committed catalog wake hints invalidate the
snapshot after deletes and restores, while the catalog stream remains the owner
of a restored document's return to the live tree.

`ContextViewerHost` selects one read-only surface through `previewKind`. A
tracked-classified viewer read renders as text in every host; collaborative
editing remains in `ContextDocumentHost`. URL-backed text previews use a
TanStack query so reopening a signed preview can reuse its read.
The viewer reads by document id (`GET /documents/:documentId/read`), never by path, and its
query is keyed by the same id: a rename or move elsewhere leaves the bytes on screen and
cannot make the read open another file. The server answers from the row's live text or
stored bytes; a draft view is never read here.

`RecentDocumentsLanding` is main when the address names no document. It lists this project's
recently-opened documents and navigates on click. Main's header "Recently opened"
(`showEditorRecents`) reaches it.
The address requests a document; the displayed-props seam above decides what is visible
while admission is pending or blocked. The address includes a local-document history
pointer on `/editor`. Clearing that pointer leaves the working set intact, and
Back returns to the document that was showing. Already on the chooser is a no-op.
Recording
is not the navigation adapter's job: the document row materializes after the
open intent, so a write there races persistence and is lost. Main's host
records once the document is in front of the writer, including a local draft. That
write lands in the account recents continuity record before the POST. A filed
document navigates by its readable address. A local draft reopens through the
empty-path local address (the same history pointer a new document uses), not a
fabricated path. Scratch documents participate in Editor recents; Uploads have no
editor address and are not recorded.

## Reference pages

- [Resource catalog and Editor lifecycle](resource-catalog-and-editor-lifecycle.md) —
  replica acquisition, local resource admission, hosts, and recovery.
- [Document identity bar](document-identity-bar.md) — identity chrome and the
  placement, rename, and repair contract.
- [Tree interactions](tree-interactions.md) — inline forms, entry actions,
  creation targeting, and tree invalidation.

## Downlinks

- [Server context domain](../../../../../../../apps/server/server/domains/context/AGENTS.md)
- [Desktop project shell](../../.context/CONTEXT.md)
- [Mobile project shell](../../mobile/.context/CONTEXT.md)

### Document path browsing

Resting crumbs are passive: project-menu acquisition mounts only when a crumb
opens. The source owns `own.crumbTrail(path, depth)`, including the exception for
an area not offered at the root; `own.openAt(path)` remains the full folder trail
used by placement. The first menu mounts with its final trail and highlight IDs.
Both trails come from `trailAlong(area, folders)` in `menu-tree.ts`; a folder
chip's menu uses `trailInside(folderId)`, the trail that ends inside that folder.

### Folder chip menu

`FolderMenu` is the menu every folder chip opens (composer, transcript, Editor):
the crumbs' drill-in menu, opened inside the folder. It is opened by identity:
a folder already in a held catalog opens at once; otherwise
`lookupProjectFolderAvailability` (the `folderIds` availability lookup, never
cached past the open) says which area holds it now, and the menu source acquires
that area. Nothing is acquired until a chip is pressed. A surface provides
`FolderMenuContext` (project and how it opens a document); the Editor builds its
host from the editor scope and link destination. Deleted, not visible or
unreachable folders say "This folder is no longer available."
`DocumentIdentityBar` wraps first: the path and chip stay on line one, and the
review controls drop to a second line when they don't fit beside them (flex-wrap,
no breakpoint). The side header's trailing control is pinned to line one and precedes
the controls in DOM order, so Tab goes line one, then line two. Only a line too
narrow for the controls even alone gives up labels, in order (stepper count, then
Apply label), and the path drops its parent crumbs only when the leaf would be
cut. A link-update note is a direct sibling of the path, so an absent note
occupies neither a flex item nor a gap. Under a coarse pointer every control
owns a 44px box (the row grows to 44px; the paired collapse/expand toggles share
one size), except the filename, whose width yields so line one fits the 280px
side. Horizontal hit areas are exactly the visible box; gaps stay unclaimed.


Link-update feedback derives its destination from the matched move receipt, not
from a picker-provided label. The remount registry retains only operation
selection until settlement plus the receipt note TTL; admission age never
expires a pending/offline move. Same-folder renames without changed links do
not claim a placement.

## External-file drops and pending imports

A context tree mounts one drop scope for both catalog-entry moves and external files. The entry route keeps the canonical folder target and move verdicts; the file route captures that same target for import admission. Window-level drop prevention remains active while either route can accept the drag.

Imports add only a temporary root row until reveal. Pending roots have no catalog identity or URI and reserve no namespace names; every revealed node comes from the catalog.
