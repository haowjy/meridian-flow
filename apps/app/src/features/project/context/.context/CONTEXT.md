# features/project/context — contracts and architecture

Reference depth. Read the [AGENTS.md](../AGENTS.md) first.

## Link navigation versus editor admission

The ready Editor Work and Work-scoped tabs carry their Work row id, including
No Work. Viewer reads and route matching use that ownership, never the host
Chat Work. Unresolved Editor Work cannot bootstrap Context or register a
removal host. The selected-tab map is keyed by Work row id; project-scoped
files retain the Editor's Work context.

`ProjectDocumentNavigationAdapter` opens both tracked editors and existing
read-only Context viewers through the one stable-ID opener. Its lower-level
`not-editable` result means no live Yjs admission, not a failed navigation:
Editor-eligible project binary/custom metadata still opens a viewer tab and route.
Scratch documents open Editor tabs owned by their resolved Work, or by their lineage
(`rootThreadId` and the handle its URI spells) when they are a No Work chat's notes.
Uploads route to the deferred-viewing notice without opening a tab. The resolved file's
Work/no-Work authority overrides the invoking surface's Work; only project-scoped
files retain host Work context. Never add upload-specific navigation in Composer.

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
The authenticated provider boundary also re-scopes the client creation
registry, clearing transient Project creation records when the account
changes; Work command records (including creates) clear through the account's
abort signal in `work-command-store`. Neither is reload recovery.

The replica uses short account/resource Web Locks for namespace and terminal
coordination. Typing and ordinary local content access do not hold those locks.
A stable resource handle survives document-ID remint; the exact persistence name
and mounted Y.Doc do not change. The resource descriptor also retains the
catalog-defined file classification so cached code never reopens as rich text.

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
       ├─ useRenameEntryForm ────────────────┤
       ├─ useDeleteConfirmation ─────────────┤
       └─ ContextEntryActions (menus) ───────┘
                     │
      useInlineEdit (components/ui, shared core)
                     │
          validateContextEntryName (pure)

ContextPaneController
       ├─ route ↔ server-tab reconciliation
       ├─ in-memory ContextTab[] (tracked, viewer, and new)
       └─ ContextViewer
              ├─ ContextTabBar (reviewing tab surfaces dock tone)
              ├─ DocumentPaneChrome (shared with the dock's document)
              │     ├─ PassageNotice, ArchivedWorkNotice
              │     └─ DocumentIdentityBar (breadcrumb + DraftReviewChip and painted DraftReviewBand)
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
