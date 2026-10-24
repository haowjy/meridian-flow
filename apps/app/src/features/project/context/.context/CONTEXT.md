# features/project/context — contracts and architecture

Reference depth. Read the [AGENTS.md](../AGENTS.md) first.

## Link navigation versus editor admission

The ready Editor Work and Work-scoped tabs carry their Work row id, including
No Work. Viewer reads and route matching use that ownership, never the host
Chat Work. Unresolved Editor Work cannot bootstrap Context or register a
removal host. The selected-tab map is keyed by Work row id; project-scoped
files retain the Editor's Work context.

`ProjectDocumentNavigationAdapter` turns a known file identity into an Editor,
dock, or background destination before content opens. An ID absent from the
in-memory resource projection waits for one availability lookup; its available
answer is consumed once by the installed tab instance. The destination alone
opens local content, admits the live room, and presents Retry. Read-only Context
files still open viewer tabs without live Yjs admission. Background tabs do not
carry lookup answers because they acquire content only when shown. Closing or
replacing a destination discards its unconsumed answer.
Scratch documents open Editor tabs owned by their resolved Work, or by their lineage
(`rootThreadId` and the handle its URI spells) when they are a No Work chat's notes.
Uploads route to the deferred-viewing notice without opening a tab. The resolved file's
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

`DesktopProjectController` owns the displayed Editor value for `DesktopProject`.
It selects the retained same-Work pane and boundary visibility once, then resolves
its tab identity through `resolveVisibleEditorTab` (local pointer, persisted tab
selection, and removal binding) and applies the current resource projection.
The pane consumes that resolved result; the rail captures the same visible tab at
the click. A retained pane carries itself; hidden error, unavailable, recovery and
chooser presentations carry nothing. No route-shaped Editor props travel back to
the route, and no separate active-document pointer is stored.

## Architecture

```text
ContextTreePanel (desktop)          MobileContextBrowser (mobile)
       │                                     │
       ├─ useContextCatalogViews (batched projection) ┤
       ├─ useCreateEntryForm ────────────────┤
       ├─ useEntryInteraction ───────────────┤
       │     └─ rename forms + move picker   │
       ├─ useDeleteContextEntry ─────────────┤
       └─ ContextEntryActions (menus) ───────┘
                     │
      useInlineEdit (components/ui, shared core)
                     │
          validateContextEntryName (pure)

Delete Undo notices are owned by `DocumentDeleteUndoProvider` and rendered as
one replaceable `SurfaceNotice` per host surface. The sidebar host sits between
the tree and Scratch; Work Files and the mobile browser host theirs at their
own foot.

ContextPaneController
       ├─ route ↔ server-tab reconciliation
       ├─ in-memory ContextTab[] (tracked, viewer, and new)
       └─ ContextViewer
              ├─ ContextTabBar (reviewing tab surfaces dock tone)
              ├─ DocumentPaneChrome (shared with the dock's document)
              │     ├─ PassageNotice, ArchivedWorkNotice
              │     └─ DocumentIdentityBar (DocumentPath crumbs + chips and painted DraftReviewBand)
              ├─ ContextEditorMountHost (warm-set LRU)
              │     └─ ContextDocumentHost per tab (session boundary + EditorView;
              │        the dock's document renders the same host)
              ├─ ContextViewerHost (active read-only viewer)
              └─ RecentDocumentsLanding (empty workspace only)
```

`ContextViewerHost` selects one read-only surface through `previewKind`. A
tracked-classified viewer read renders as text in every host; collaborative
editing remains in `ContextDocumentHost`. URL-backed text previews use a
TanStack query so reopening a signed preview can reuse its read.

`RecentDocumentsLanding` is the empty pane. It lists this project's recently-opened
documents and navigates on click. It does not open a tab on mount. The tab
strip's leading control (`showEditorRecents`) reaches it without closing a tab.
The address requests a document; the displayed-props seam above decides what is visible
while admission is pending or blocked. The address includes a local-document history
pointer on `/editor`. Clearing that pointer leaves the working set intact, and
Back returns to the document that was showing. Already on the chooser is a no-op.
Recording
is not the navigation adapter's job: the document row materializes after the
open intent, so a write there races persistence and is lost. The active editor
tab records once it is in front of the writer, including a local draft. That
write lands in the account recents continuity record before the POST. A filed
document navigates by its readable address. A local draft reopens through the
empty-path local address (the same history pointer a new document uses), not a
fabricated path. Scratch documents participate in Editor recents; Uploads do not
open Editor tabs and are not recorded.

## Reference pages

- [Resource catalog and Editor lifecycle](resource-catalog-and-editor-lifecycle.md) —
  replica acquisition, local resource admission, Editor tabs, recovery, and
  browser-local workspace membership.
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
`DocumentIdentityBar` wraps first: the path and chip stay on line one, and the
review controls drop to a second line when they don't fit beside them (flex-wrap,
no breakpoint). The dock's trailing Collapse is pinned to line one and precedes
the controls in DOM order, so Tab goes line one, then line two. Only a line too
narrow for the controls even alone gives up labels, in order (stepper count, then
Apply label), and the path drops its parent crumbs only when the leaf would be
cut. A link-update note is a direct sibling of the path, so an absent note
occupies neither a flex item nor a gap. Under a coarse pointer every control
owns a 44px box (the row grows to 44px; the paired collapse/expand toggles share
one size), except the filename, whose width yields so line one fits the 280px
dock. Horizontal hit areas are exactly the visible box; gaps stay unclaimed.


Link-update feedback derives its destination from the matched move receipt, not
from a picker-provided label. The remount registry retains only operation
selection until settlement plus the receipt note TTL; admission age never
expires a pending/offline move. Same-folder renames without changed links do
not claim a placement.
