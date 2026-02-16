# Frontend Rules (React / Zustand / CodeMirror)

These rules apply when `frontend/` files are in the diff.

## Import Boundaries

1. **`core/` never imports from `features/`**: Core modules must not depend on feature modules. Dependency flows one way: features → core.

## Race Condition Prevention

2. **Intent flags for stale responses**: Use `_activeId` or similar intent flags to discard responses that arrive after the user has moved on.
3. **Module-level AbortControllers**: Use AbortController for all async loads. Cancel stale operations proactively when user switches views.

## Store Conventions

4. **Subscribe for display, `getState()` for actions in effects**: If an effect updates store state, it must read that state via `getState()`, not subscribe (prevents infinite loops).
5. **Separate loading flags**: Use separate flags for different operations (`isLoadingThreads`, `isLoadingMessages`), not a single boolean.
6. **Silent abort errors**: Abort errors should be silently ignored (user cancelled). Show all other errors.

## Error Handling

7. **`handleApiError(error, fallback)` in catch blocks**: Use the shared helper from `core/lib/errors.ts` for consistent error toasts.
8. **`isAbortError(error)` for early returns**: Check for abort before any error handling logic.

## Styling

9. **`cursor: pointer` on interactive elements**: Global CSS handles buttons and `[role="button"]`. Manually add `cursor-pointer` to clickable `<a>`, `<Link>`, and `<div>` elements.
10. **`cn()` for conditional/mergeable styles**: Use the `cn()` utility (clsx + tailwind-merge) for conditional class names.
11. **No `@apply` just for "cleaner" JSX**: Only use `@apply` when genuinely needed (global styles, pseudo-elements). Inline Tailwind classes in JSX are preferred.
12. **Compact over spacious for UI chrome**: Use smaller padding/gaps (`px-1.5 py-1`) for non-content UI elements. Content areas get generous spacing.

## Component Patterns

13. **Container/Presenter split for complex components**: Separate data-fetching/logic (container) from rendering (presenter) when a component does both.
14. **Progressive disclosure**: Show less by default, reveal on interaction.

## Data Transformation

15. **Backend snake_case → frontend camelCase via DTO converters**: Don't leak snake_case into frontend code. Convert at the API boundary.

## Tooling

16. **Use `pnpm`, not `npm`**: All package management commands must use pnpm.
17. **Run `pnpm run lint`**: After making changes, ensure ESLint passes.
18. **Run `pnpm run format`**: After Tailwind/CSS class changes, run Prettier.

## CodeMirror

19. **No `Cmd-[` / `Cmd-]` bindings**: These are reserved for browser navigation. Don't bind them in CodeMirror keymaps.
20. **Autosave on navigation**: `EditorPanel` flushes on unmount/document switch. Don't add duplicate save logic.

## Caching Patterns

21. **Documents: Reconcile-Newest**: Always fetch server, compare with cache by `updatedAt`, render newest.
22. **Threads/Messages: Network-First**: Server is source of truth. No local-first patterns.
23. **Metadata: Persist Middleware**: Small data (project list, UI state) uses Zustand persist to localStorage.

## Theme System

24. **Semantic color names**: Use `primary` for interactive elements, `favorite` for special emphasis. Don't use raw hex colors.
25. **8pt grid spacing**: Standard gap is `gap-2` (8px). Follow the grid for consistent spacing.
