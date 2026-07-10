# features/project/context — Context file tree (desktop + mobile)

The context file tree — a unified explorer for project context files
(`manuscript://`, `kb://`, `user://`, `scratch://`, `uploads://`). Desktop uses a
recursive expand/collapse tree (`ContextTreePanel`); mobile uses one-folder-per-screen
drill-in navigation (`MobileContextBrowser`). Both surfaces share hooks, types,
and validation through this module.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) for contracts, architecture, and patterns in detail.

## Mental model

The tree is a **browse surface** over the server's context port. It reads from
`useContextTree` (React Query), writes through mutation hooks
(`useCreateContextEntry`, `useRenameContextEntry`, `useDeleteContextEntry`),
and invalidates the tree cache on mutation success.

Desktop renders the full tree recursively. Mobile renders one level at a time
(scheme root → folder listing → file), with `?scheme=` / `?folder=` / `?path=`
route params driving the current level.

Both shells share:
- **Entry name validation** (`context-entry-name.ts`): collision check, empty
  rejection, whitespace-only warning
- **Inline name forms** (`useInlineNameForm`): shared state machine for create
  and rename forms
- **Entry actions** (`ContextEntryActions.tsx`): dual-trigger menu
  (context menu + kebab), delete confirmation dialog, and `EntryActionTarget` type

## Key rules

1. **Use canonical primitives.** Buttons for actions use `IconButton` (kebab)
   or `Button` (delete dialog). Never hand-roll a button with raw `className`.
2. **Inline name forms use `useInlineNameForm`.** Both `useCreateEntryForm` and
   `useRenameEntryForm` are thin adapters over the shared core. Add new inline
   name fields by extending the core, not by forking.
3. **Actions dispatch through `EntryAction`.** Both the right-click context menu
   and the hover-revealed kebab use the same `EntryAction` type (`"rename" |
   "delete"`) and share `ActionMenuItems`. Add actions once; both triggers
   inherit them.
4. **`EntryActionTarget` is the shared action payload.** All `onRequestDelete`
   and action handlers use `{ name, path, kind }` from this type. Do not inline
   the shape.
5. **Mobile DrillRow separates tap target from trailing actions.** The row
   structure is `<div>` wrapping `<button>` (full-width tap area) + trailing
   slot (action buttons that don't trigger navigation). Use `trailing:
   ReactNode`, never a `drillsIn` boolean.
6. **Desktop tree: one scroll surface.** The tree is a continuous flex-column;
   sections and rows are natural height. Blank space pools at the bottom.
   Only the tree root scrolls.

## Anti-patterns

- **Don't hand-roll inline name forms.** Use `useInlineNameForm` (or an adapter
  over it). Duplicating the state machine creates a parallel hierarchy.
- **Don't hand-roll action buttons.** Use `IconButton` / `Button` / `PhoneIconButton`.
- **Don't inline `{ name, path, kind }`.** Import `EntryActionTarget`.
- **Don't fold action dispatching into navigation.** The desktop context menu
  and kebab are separate from row click (which opens files / toggles folders).
  The mobile `DrillRow` trailing slot is separate from the tap target.
- **Don't add a third trigger for the same actions.** Two is the pattern:
  right-click context menu + hover-revealed kebab.

## File groups

- **Shells**: `ContextTreePanel.tsx` (desktop), `MobileContextBrowser.tsx` (mobile)
- **Actions**: `ContextEntryActions.tsx` (menus, delete dialog, `EntryActionTarget`)
- **Inline forms**: `use-inline-name-form.ts` (core), `use-create-entry-form.ts`,
  `use-rename-entry-form.ts`, `context-entry-name.ts` (validation)
- **Tab/route**: `ContextTabBar.tsx`, `context-tab-identity.ts`,
  `context-tab-from-file.ts`, `context-tab-from-draft.ts`, `context-last-route.ts`
- **Viewing/editing**: `ContextViewer.tsx`, `ContextViewerHost.tsx`,
  `ContextEditorMountHost.tsx`, `ContextDocumentBreadcrumb.tsx`, `document-toolbar.tsx`
- **Data**: `context-tree.ts` (query + invalidation), `context-schemes.ts`,
  `context-files-store.ts`, `context-file-icon.ts`, `context-create-kind.ts`
