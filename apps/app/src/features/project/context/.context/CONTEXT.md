# features/project/context — contracts and architecture

Reference depth. Read the [AGENTS.md](../AGENTS.md) first.

## Link navigation versus editor admission

The ready Editor Work and Work-scoped documents carry their Work row id, including
No Work. Viewer reads and route matching use that ownership, never the host
Chat Work. Unresolved Editor Work cannot bootstrap Context or register a
removal host. Project-scoped files retain the Editor's Work context.

`ProjectDocumentNavigationAdapter` turns a known file identity into main's address before
content opens: every door opens in main. An ID absent from the in-memory resource projection
waits for one identity lookup; its available answer is consumed once by the destination.
The destination alone opens local content, admits the live room, and presents Retry. Read-only
Context files still open a viewer without live Yjs admission. Closing or replacing a
destination discards its unconsumed answer.
Scratch documents open in main owned by their resolved Work, or by their lineage
(`rootThreadId` and the handle its URI spells) when they are a No Work chat's notes.
Uploads have no editor address: the adapter opens one in `UploadViewerDialog` (the read-only
viewers), whichever pane the door is in. The resolved file's
Work authority overrides the invoking surface's Work; only project-scoped
files retain host Work context. Never add upload-specific navigation in Composer.

The replay has explicit waiting, complete and denied states (`resolveIn`: a node, "not there", or
"waiting for the list"). A host waits for the list to sync; waiting is never treated as missing.

What the list says about a document's removal reaches the coordinator through `applyRemovals`, which is
refused while removal is suspended or disposed.

## Tree ownership

A project's tree is an append-only list of records, replayed into a tree. The browser holds one
copy per list (the project's and the account's, for `user://`) in a `TreeListSession`, and is
the writer of its own records: `TreeActions` appends a create, rename, move, delete or restore to
the copy, the replay shows it at once, and Yjs carries it to the server. Nothing waits on a
request, and nothing else remembers placement: sidebar, tabs, identity bar, pickers, mentions,
Recents, folder chips and Trash membership read `useProjectTreeViews` / `useProjectTrees`, which cut
the session's replay to a source. Those read live unless they name a version; the sidebar names the
shell's Live/Draft toggle, and `TreeActions` acts in that version, so on Draft a record carries the
Work's branch as `draft` ([sidebar version](../../.context/tree-version-state-machine.md)). The replay is computed once per change and the writer's
failures once per version, however many views read them.

The queries own only what the list cannot say: which sources exist (every source is made in the
transaction that makes its project, account or Work, so a tree without one is a bug and renders
nothing), each Work's authority, Trash times and retention, and a chat's uploads.

Whoever makes a record names it as its own copy shows it: a create, a rename, and a move into a
name that is taken record the numbered name (a move is a `move` and a `rename` in one update;
a move record has no name). The replay numbers only a clash nobody could see.

A refusal comes back as a `refused` settlement on the record and shows on the row as its
failure mark with the repair the writer asked for (`tree-failures.ts`). A tree action that cannot
be appended returns a `TreeActionResult` with a reason the writer can act on
(`tree-action-message.ts` words it): a name the list cannot hold, a folder or node no longer
there, a read-only or denied list, a list still loading.

The close of `AccountFeatureLifetime` releases the lists with the rest of the account's state.
## Visible Editor ownership

The address owns what main shows: `resolveMainDocument` finds its document by identity, then by
path, the same on desktop and phone. Main's tabs (`client/project-shell/main-tabs.ts`) follow the
address, never lead it: arriving at a document opens or selects its tab. Hosts mount their
documents in `PresentedDocuments` (`presented-documents.ts`: places main, side and kept). Its
`documents` are main's and the side's only (main first): the removal coordinator
and removed notices read them to know what is on screen. Its `shown` list, every mounted document
newest on screen first, is where the desktop picks the kept host (an open tab only); the coordinator's close, Discard and removal paths `forget` a document there, which also
closes its tab, so its host unmounts. One document has at most one host, keyed `document:<id>` (`DocumentHost.tsx`), so a move
between main and the side doesn't remount it.

## Architecture

```text
ContextTreePanel (desktop sidebar and the phone's drawer)
       ├─ useProjectTreeViews (the replay, cut to sources)
       ├─ useCreateEntryForm
       ├─ useEntryInteraction
       │     └─ rename forms + move picker
       ├─ useDeleteContextEntries
       └─ ContextEntryActions (menus)
                     │
      useInlineEdit (components/ui, shared core)
                     │
          validateContextEntryName (pure)
```

Trash is a server snapshot of the lists' entries, separate from the replay: one entry per delete
in force, a document deleted on its own or a folder with what its delete took (an empty folder too),
restored whole. The tree doesn't read it: Trash is a sidebar source (`shell/sidebar/TrashSource.tsx`)
listing it newest first on `ListRow`s that select and drag like the trees'. An entry shows while
the replay has a delete of its node in force. A folder entry has no page yet (opening a deleted
folder is the design's later step): its menu and a drag restore it. A deleted document has its own address,
`/p/<id>/trash/<documentId>`, and opens like any document: the sidebar shows Trash with its
row current, and main shows `TrashedDocument`, the text read-only under a notice with Restore.
An uploaded file shows its card (name, type, size from the replay's blob) instead of text: the
server serves no file in Trash, so the card has no Download.
The notice's place, author and the tab's name come from the replay, so they read offline; the
date and retention come from the server's read of the document, else from the Trash list the
browser holds.
It takes no tab; the strip shows it as an untabbed chip, as it does an address that names nothing. Main follows the document out of Trash, whichever
Restore brought it back, by opening it in place. The record reads the server's Markdown,
serialized from the document's frozen Yjs, and composes `ReadOnlyViewerFrame` with `TextViewer`;
it never uses the live path-based read. Stable-ID navigation confirms a deleted document through
that endpoint before opening it. Every restore is a `restore` record appended to the list
(`DocumentTrashRestoreProvider`); the entry leaves the Trash snapshot at once, the replay owns the
document's return to the live tree, and a restore the server refuses puts the entry back with
the server's reason.

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
document navigates by its readable address, a new document by the name the replay gives its node
(the empty path is the chooser). Scratch documents participate in Editor recents; Uploads have no
editor address and are not recorded.

## Reference pages

- [Presented documents and Editor lifecycle](resource-catalog-and-editor-lifecycle.md) —
  hosts, removal notices, draft-only presentation and recovery.
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
the project's replay (`useProjectTrees`) says which source holds it now, a rename or move made a
moment ago included. Nothing is read until a chip is pressed. A surface provides
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

A context tree mounts one drop scope for both row moves and external files. The entry route keeps the canonical folder target and move verdicts; the file route captures that same target for import admission. Window-level drop prevention remains active while either route can accept the drag.

Imports add only a temporary root row until reveal. Pending roots have no node id or URI and reserve no names; every revealed node comes from the replay.
