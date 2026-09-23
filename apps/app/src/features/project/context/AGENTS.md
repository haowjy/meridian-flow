# features/project/context — Context file tree (desktop + mobile)

Explorer surfaces for project documents (`manuscript://`, `kb://`, `user://`,
`unfiled://`). Scratch/Uploads are chat resources, not ordinary Editor tabs;
reference/tool vocabulary still includes them. `ContextTreePanel` renders the recursive tree in the
desktop sidebar and phone navigation drawer; the phone Files destination uses
one-folder-per-screen drill-in (`MobileContextBrowser`).

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) for contracts and architecture.

## Mental model

A **browse surface** over the account resource replica. The replica owns durable
resource descriptors, catalog checkpoints, local content access, and file namespace
work. React Query delivers acquisition results to consumers; it is not a second
catalog owner. Folder commands and excluded chat resources still use the direct
context API.

`ContextTreePanel` and `ContextTreeRows` project direct children by stable parent
ID from the normalized catalog. `MobileContextBrowser` renders the phone Files
destination one level at a time (scheme → folder → file), driven by `?scheme=` /
`?folder=` / `?path=` params.

Shared across both shells:
- **File suggestions** (`file-suggestions/`): reusable client-side flattening,
  ranking, cached multi-scheme query composition, and keyboard-accessible list.
- **Inline name forms** (`useInlineNameForm`): shared state machine; create and
  rename are thin adapters over it. Extend the core, don't fork.
- **Entry actions** (`ContextEntryActions.tsx`): desktop has two triggers
  (right-click context menu + hover kebab) rendered from one ordered action
  specification. Add an action once; both primitive-specific renderers inherit it.
  Uploads omits generic Delete because only the identity/revision-bound intake
  contract may delete an upload.
- **Validation** (`context-entry-name.ts`): collision check, empty rejection,
  whitespace warning.

## Rules

- Use `IconButton` / `Button` / `PhoneIconButton` for all interactive controls.
- Use discriminated `EntryActionTarget`; file targets retain `documentId`
  through confirmation, while folders carry no document identity.
- Mobile `DrillRow`: `trailing: ReactNode` separates the tap target from action
  buttons. Never a `drillsIn` boolean.
- Desktop tree: one scroll surface. The tree is a continuous flex-column; only
  the tree root scrolls.
- Two triggers for entry actions (context menu + kebab), not three.
- The empty Editor pane is a chooser (`RecentDocumentsLanding`): the project's
  recently-opened documents, including viewers. A row navigates. It never
  seeds a tab. The strip's leading control reaches it with tabs still open:
  `routeCommands.showEditorRecents` clears the address, including a local-document
  history pointer, and leaves the working set alone. Already on the chooser is a
  no-op. Back returns to the document that was showing.
- Record from the active editor tab, not from the open intent and not from the
  create path. A parked restored tab is not an open. Opening the new document
  records it, including a local draft, once that tab is in front of the writer.
  The device record updates before the POST. `recordRecentDocument` still owns
  the retry that covers the window between reserving a document id and the
  server writing its row. The server's five-second interval is write hygiene:
  it does not decide whether this device shows the opening.

## File groups

- **Shells**: `ContextTreePanel.tsx` (desktop scheme/query orchestration),
  `ContextTreeRows.tsx` (direct-child desktop rows), `MobileContextBrowser.tsx`
  (phone Files destination)
- **Actions**: `ContextEntryActions.tsx` (menus, delete dialog, `EntryActionTarget`)
- **Inline forms**: `use-inline-name-form.ts` (core), `use-create-entry-form.ts`,
  `use-rename-entry-form.ts`, `context-entry-name.ts` (validation)
- **Tab/route**: `ContextTabBar.tsx`, `context-tab-identity.ts`,
  `context-tab-from-file.ts`, `context-tab-from-draft.ts`; the browser-level
  removal coordinator owns live removal, route identity, and continuity, while
  `../ContextPaneController.tsx` owns ordinary view activation
- **Viewing/editing**: `ContextViewer.tsx`, `ContextViewerHost.tsx`,
  `ContextEditorMountHost.tsx`, `DocumentIdentityBar.tsx` + `IdentityPlacementField.tsx`
  (the universal breadcrumb band — placement, rename, and move share one inline
  field, committed through `use-identity-commit.ts`). Resource-backed tabs retain
  one stable handle and editor ancestry through create, acknowledgement, rename,
  remint, and catalog refresh.
- **Creation coordination**: `TreeCreationProvider.tsx` owns the shared tree and
  Editor-empty-state create request
- **Data**: `client/query/useContextCatalog.ts` (replica acquisition plus flat UI
  projection), `core/resources/account-resource-replica.ts` (account owner),
  `context-schemes.ts`, `context-file-icon.ts`, `context-create-kind.ts`
- **Suggestions**: `file-suggestions/` (pure matcher, data hook, presentational list)
