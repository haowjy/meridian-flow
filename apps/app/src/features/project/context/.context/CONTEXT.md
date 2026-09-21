# features/project/context — contracts and architecture

Reference depth. Read the [AGENTS.md](../AGENTS.md) first.

## Link navigation versus editor admission

Resolved No Work survives routing in browser-entry state without an empty query parameter. Work-capable tabs without a
`workId` belong to No Work; viewer reads and route matching must not inherit the
host Chat Work. Nullable authority is ready for Context bootstrap and removal
host registration, not a loading/missing-Work state. No-Work server tabs use
route selection; the selected-tab map uses the empty-string key for shared project scope.

`ProjectDocumentNavigationAdapter` opens both tracked editors and existing
read-only Context viewers through the one stable-ID opener. Its lower-level
`not-editable` result means no live Yjs admission, not a failed navigation:
Editor-eligible project binary/custom metadata still opens a viewer tab and route.
Scratch/Uploads instead route to the deferred-viewing notice without opening a tab. The resolved file's
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

The replica uses short account/resource Web Locks for namespace and terminal
coordination. Typing and ordinary local content access do not hold those locks.
A stable resource handle survives document-ID remint; the exact persistence name
and mounted Y.Doc do not change. The resource descriptor also retains the
catalog-defined file classification so cached code never reopens as rich text.

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
              useInlineNameForm (shared core)
                     │
          validateContextEntryName (pure)

ContextPaneController
       ├─ route ↔ server-tab reconciliation
       ├─ in-memory ContextTab[] (tracked, viewer, and new)
       └─ ContextViewer
              ├─ ContextTabBar (reviewing tab surfaces dock tone)
              ├─ DraftReviewHeader (review strip, above the identity bar)
              ├─ DocumentIdentityBar (breadcrumb + chips, incl. DraftReviewChip)
              ├─ ContextEditorMountHost (warm tracked + local-resource Yjs editors)
              ├─ ContextViewerHost (active binary viewer)
              └─ RecentDocumentsLanding (empty workspace only)
```

`RecentDocumentsLanding` is the empty pane. It lists account recently-opened
documents and navigates on click. It does not open a tab on mount. Recording
is not the navigation adapter's job: the document row materializes after the
open intent, so a write there races persistence and is lost. The active
tracked or viewer tab records once the document is real. File create records
the reservation's document id, because that tab does not exist until the
catalog projects it. Scratch and uploads are not Editor tabs, so they are
not recorded.

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
