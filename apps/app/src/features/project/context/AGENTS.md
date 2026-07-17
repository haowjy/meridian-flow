# features/project/context — Context file tree (desktop + mobile)

Explorer surfaces for project context files (`manuscript://`, `kb://`, `user://`,
`scratch://`, `uploads://`). `ContextTreePanel` renders the recursive tree in the
desktop sidebar and phone navigation drawer; the phone Files destination uses
one-folder-per-screen drill-in (`MobileContextBrowser`).

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) for contracts and architecture.

## Mental model

A **browse surface** over the server's context port. Reads from `useContextTree`
(React Query), writes through mutation hooks, invalidates the tree cache on
success.

`ContextTreePanel` renders the full tree recursively. `MobileContextBrowser`
renders the phone Files destination one level at a time (scheme → folder → file),
driven by `?scheme=` / `?folder=` / `?path=` params.

Shared across both shells:
- **File suggestions** (`file-suggestions/`): reusable client-side flattening,
  ranking, cached multi-scheme query composition, and keyboard-accessible list.
- **Inline name forms** (`useInlineNameForm`): shared state machine; create and
  rename are thin adapters over it. Extend the core, don't fork.
- **Entry actions** (`ContextEntryActions.tsx`): desktop has two triggers
  (right-click context menu + hover kebab) dispatching the same `EntryAction`
  type through shared `ActionMenuItems`. Add an action once; both triggers
  inherit it.
- **Validation** (`context-entry-name.ts`): collision check, empty rejection,
  whitespace warning.

## Rules

- Use `IconButton` / `Button` / `PhoneIconButton` for all interactive controls.
- Use `EntryActionTarget` (`{ name, path, kind }`) as the shared action payload.
- Mobile `DrillRow`: `trailing: ReactNode` separates the tap target from action
  buttons. Never a `drillsIn` boolean.
- Desktop tree: one scroll surface. The tree is a continuous flex-column; only
  the tree root scrolls.
- Two triggers for entry actions (context menu + kebab), not three.

## File groups

- **Shells**: `ContextTreePanel.tsx` (desktop sidebar and phone drawer), `MobileContextBrowser.tsx` (phone Files destination)
- **Actions**: `ContextEntryActions.tsx` (menus, delete dialog, `EntryActionTarget`)
- **Inline forms**: `use-inline-name-form.ts` (core), `use-create-entry-form.ts`,
  `use-rename-entry-form.ts`, `context-entry-name.ts` (validation)
- **Tab/route**: `ContextTabBar.tsx`, `context-tab-identity.ts`,
  `context-tab-from-file.ts`, `context-tab-from-draft.ts`, `context-last-route.ts`;
  the parent `../ContextPaneController.tsx` owns reconciliation and selection
- **Viewing/editing**: `ContextViewer.tsx`, `ContextViewerHost.tsx`,
  `ContextEditorMountHost.tsx`, `DocumentIdentityBar.tsx` + `IdentityPlacementField.tsx`
  + `IdentityMovePopup.tsx` (the universal breadcrumb band — inline rename AND
  move live there, committed through `use-identity-commit.ts`). New untitled
  tabs use the same Yjs-first editor as tracked documents; the detached
  session is materialized by the `untitled-reconciler.ts` engine;
  `untitled-reconciler-browser.ts` owns browser/API/React bindings.
- **Creation coordination**: `TreeCreationProvider.tsx` owns the shared tree and
  Editor-empty-state create request
- **Data**: `context-tree.ts` (query + invalidation), `context-schemes.ts`,
  `context-file-icon.ts`, `context-create-kind.ts`
- **Suggestions**: `file-suggestions/` (pure matcher, data hook, presentational list)
