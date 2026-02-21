# Frontend AGENTS.md

Instructions for Agents when working with the Meridian frontend.

See main `AGENTS.md` for general principles. This document focuses on frontend-specific patterns.

## Tech Stack

- **Framework**: Vite + TanStack Router
- **State Management**: Zustand with persist middleware
- **Local Database**: Dexie (IndexedDB wrapper)
- **Editor**: CodeMirror 6 (markdown-native with live preview)
- **Styling**: Tailwind CSS
- **UI Components**: Radix UI + shadcn/ui

## Development Commands

```bash
pnpm run dev          # Start dev server (http://localhost:3000)
pnpm run build        # Production build
pnpm run lint         # ESLint
pnpm run format 2>&1 | grep -v "unchanged"       # Prettier write (including Tailwind class sorting)
pnpm run format 2>&1 | grep -v "unchanged":check # Prettier check-only
pnpm run test         # Vitest unit tests (core libs + services)
pnpm run test:watch   # Vitest in watch mode
```

## Authentication

**Status**: ✅ Complete (Supabase Auth integration)

Cookie-based sessions with automatic JWT injection into all API calls. TanStack Router handles route protection. Google OAuth only (no email/password).

- **Supabase client**: `src/core/supabase/client.ts`
- **JWT injection**: Automatic via `src/core/lib/api.ts:21-27` — no action needed in components
- **Route protection**: TanStack Router `beforeLoad` hooks. Unauthed -> `/login`, authed on `/login` -> `/projects`
- **Env vars**: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (see `.env.example`)

**Full documentation**: `_docs/technical/frontend/auth-implementation.md`

## Architecture Overview

### Caching Strategy

Three distinct caching patterns based on data characteristics:

#### 1. Documents (Reconcile-Newest)

**Pattern**: Always fetch server; compare with cache by `updatedAt`; render newest (local wins on tie)

- Emit cached content immediately if present (read-only), reconcile with server
- Optimistic updates + retry on network failure
- **Implementation**: `useEditorStore.ts`
- **Utilities**: `loadWithPolicy(new ReconcileNewestPolicy())` in `core/lib/cache.ts`

#### 2. Threads/Messages (Network-First)

**Pattern**: Server is source of truth.

- Fetch from API first
- No local caching (Dexie) currently implemented
- **Implementation**: `useThreadStore.ts`
- **Rendering**: prefer `turnIds` + `turnById` (normalized) so streaming updates only re-render the affected turn row
- **Scrolling**: `useThreadScrollController.ts` owns initial scroll-to-bookmark, streaming follow/pause + settle, and sticky-composer resize anchor preservation

#### 3. Metadata (Persist Middleware)

**Pattern**: Small data, synchronous access via localStorage

- Project list, active IDs, UI state
- Uses Zustand `persist` middleware
- No IndexedDB needed (< 5MB localStorage limit)
- **Implementation**: `useProjectStore.ts`, `useUIStore.ts`

### Store Architecture

**Location**: `frontend/src/core/stores/`

All stores use Zustand. Key conventions:

- **Abort controllers**: Cancel previous requests when user switches views
- **Loading flags**: Separate flags for different operations (e.g., `isLoadingThreads`, `isLoadingMessages`)
- **Error handling**: Silent abort errors, show others to user
- **Optimistic updates**: Update local state immediately, sync to server in background

**Stores**:

- `useEditorStore.ts` - Document editing (cache-first)
- `useThreadStore.ts` - Threads and messages (network-first with windowing)
- `useProjectStore.ts` - Project list (persist middleware)
- `useTreeStore.ts` - Document tree structure (network-first, bulk cache)
- `useUIStore.ts` - UI state (persist middleware)

#### Subscribe for Display, Read for Action

**Critical pattern to avoid infinite loops:**

- **Subscribe** (useStore selector in component) = component needs to RE-RENDER when state changes
- **Read** (`getState()`) = effect/action needs current value without triggering re-runs

If an effect **updates** store state, it must **read** that state via `getState()`, not subscribe:

```tsx
// ❌ BAD: Creates infinite loop
const { items } = useStore((s) => ({ items: s.items }))
useEffect(() => {
  useStore.getState().updateItems(...)  // Updates items
}, [someCondition, items])  // items in deps -> effect re-runs -> loop!

// ✅ GOOD: Read inside effect
useEffect(() => {
  const items = useStore.getState().items  // Read without subscribing
  useStore.getState().updateItems(...)
}, [someCondition])  // No items in deps
```

### Navigation Pattern

Document and panel navigation uses a **two-pronged approach**:

1. **Direct state updates** via `panelHelpers` (instant feedback, handles same-URL clicks)
2. **URL sync effect** in `WorkspaceLayout` (syncs UI to URL on back/forward/refresh)

**URL Format:** Documents use path-based slugs: `/projects/{project}/documents/{folder/path/docname}`

- Splat route (`$.tsx`) captures all segments after `/documents/`
- WorkspaceLayout resolves slug -> UUID via tree store

**Key pattern**: Use `getState()` in effects to read state without subscribing:

- Prevents unnecessary effect re-runs when state changes
- Allows independent effects (document URL vs thread query params)
- Essential for future thread integration (thread persists across document navigation)

**Implementation:**

- Navigation helpers: `frontend/src/core/lib/panelHelpers.ts`
- URL sync effect: `frontend/src/features/workspace/components/WorkspaceLayout.tsx`
- **See**: `_docs/technical/frontend/architecture/navigation-pattern.md` for comprehensive guide

### Sync System

- Document save: `core/services/documentSyncService.ts`, `core/lib/persistentSaveDrain.ts`
- Tree queue: `core/services/treeSyncService.ts`, `core/lib/treeQueueDrain.ts`
- Shared helpers: `core/lib/cache.ts`, `core/lib/retry.ts`, `core/lib/sync.ts`

Both paths use optimistic updates + persistent retry queues. Dev: `VITE_DEV_TOOLS=1` for retry inspector.

**See**: `_docs/technical/frontend/architecture/sync-system.md` for flows and diagrams.

### IndexedDB Schema

Schema in `core/lib/db.ts`, version 5. Tables: `documents`, `threads`, `messages`, `projectTrees`, `pendingDocumentSaves`, `pendingTreeOps`. Runtime tables (`projectTrees`, `pendingDocumentSaves`, `pendingTreeOps`) power offline-first cache/queue/drain paths.

### Logging

- Use `frontend/src/core/lib/logger.ts` -> `makeLogger('namespace')` with `debug/info/warn/error`.
- Defaults: `debug` in development, `info` in production. Override via `VITE_LOG_LEVEL`.

### Testing

- Unit tests live under `frontend/tests/` and run with Vitest.
- Focused coverage for: retry scheduler, cache policies, `DocumentSyncService`, persistent save drain, and tree queue drain/coalescing.

### Dev Tools

- Set `VITE_DEV_TOOLS=1` to show the Retry panel overlay.

## UI Philosophy: Writer-First

Meridian's UI serves the writer's creative process. Everything else is secondary.

### Core Principles

1. **Content gets the most space** - Writing is the star, UI supports it
2. **AI assists, doesn't overwhelm** - Thread is present but compact
3. **Minimal distractions** - Compact controls, calm aesthetic
4. **Flow-supporting design** - Nothing interrupts creative momentum

### Practical Guidelines

- **Compact over spacious**: Use smaller padding/gaps for UI chrome (e.g., `px-1.5 py-1` not `px-4 py-3`)
- **Hierarchy matters**: Content > Thread > Navigation > Settings
- **Progressive disclosure**: Show less by default, reveal on interaction

### Theme System

Single theme: **Modern Literary** (Warm Paper + Sage + Gold). Light/dark mode toggle via `useThemeContext()`.

- **Interactive elements**: `primary` (sage green #5F8575)
- **Special emphasis**: `favorite` (gold #F4B41A)
- **Foundation**: `background`, `surface`, `text`, `muted`
- **Spacing**: 8pt grid (`gap-2` = 8px)

**Full docs**: `_docs/technical/frontend/themes/README.md` | **Tailwind**: `_docs/technical/frontend/tailwind-strategies.md`

### Layout System

Strategy Pattern: desktop two-panel (chat 42% left, docs 58% right, resizable/collapsible) vs mobile full-screen tabs. **See**: `_docs/technical/frontend/architecture/layout-system.md`

## Key Conventions

### Empty Content Handling

Empty string `""` is valid data. Always check `!== undefined`, never falsy checks:

```typescript
// ✅ GOOD
if (content !== undefined) { ... }

// ❌ BAD
if (content) { ... }  // Fails for empty strings
```

### Race Condition Prevention

- Use AbortController for all async loads
- Cancel stale operations proactively
- Guard background operations with intent flags (e.g., `hasUserEdit`)

### CodeMirror Editor

**Content Format**:

- **Storage & Editor**: Markdown (native format throughout)
- **No conversion needed**: Unlike TipTap, CodeMirror works directly with markdown

**Component**: `CodeMirrorEditor` from `core/editor/codemirror`

- `initialContent`: Initial markdown string
- `onChange`: Callback for content changes
- `onReady`: Returns `CodeMirrorEditorRef` for programmatic access
- `editable`: Control read-only state

**Programmatic Access** via `CodeMirrorEditorRef`:

- `getContent()`: Get current markdown
- `setContent(markdown)`: Replace content
- `focus()`: Focus editor
- Formatting commands: `toggleBold()`, `toggleItalic()`, `toggleHeading(level)`, etc.

**Keyboard shortcuts (writer-first):**

- We intentionally **do not** bind `Cmd-[` / `Cmd-]` (browser/app back/forward) inside CodeMirror.
  - CodeMirror’s default keymap uses `Mod-[` / `Mod-]` for indentation, which prevents navigation shortcuts while the editor is focused.
  - See `frontend/src/core/editor/codemirror/CodeMirrorEditor.tsx`.

**Autosave on navigation:**

- `EditorPanel` does a best-effort flush on unmount/document switch (skip debounce) to reduce the chance of losing a last-second edit.
  - This relies on the existing optimistic IndexedDB update + retry-on-network-failure behavior.
  - See `frontend/src/features/documents/components/EditorPanel.tsx`.

**AI Integration** via `AIEditorRef` (from `core/editor/api`):

- `addSuggestion(range, text)`: Add AI suggestion decoration
- `acceptSuggestion(id)`: Accept suggestion
- `rejectSuggestion(id)`: Reject suggestion

### Error Handling

- Network errors (5xx, timeout, fetch fail): Automatic retry
- Client errors (4xx): Show error, manual retry only
- Abort errors: Silent (`isAbortError()` early return)

Use `handleApiError(error, fallback)` from `core/lib/errors.ts` for consistent toasts. Backend returns RFC 7807 Problem Details; API client extracts `detail || title || message || error`. 409 Conflicts include `resource` field (access via `AppError.resource`).

### Cursor Pointer on Interactive Elements

Global CSS in `globals.css` applies `cursor: pointer` to all buttons and menu items (Tailwind v4 changed buttons to `cursor: default`).

**Automatic** (no action needed):

- `<button>` elements
- `[role="button"]` elements (Radix primitives)
- `[role="menuitem"]` elements (Dropdown/Context menu items)

**Manual** (add `cursor-pointer` class):

- `<a>` / `<Link>` with custom styling
- Clickable `<div>` elements (without menu role)

**Never use**:

- `cursor-default` on clickable elements (overrides global rule)

## File Structure

```
frontend/src/
├── routes/                     # TanStack Router routes
├── core/
│   ├── components/             # Infrastructure (SyncProvider, HeaderGradientFade)
│   ├── hooks/                  # Shared hooks (useAbortController)
│   ├── lib/                    # Core utilities
│   │   ├── api.ts              # API client
│   │   ├── cache.ts            # Cache utilities
│   │   ├── db.ts               # IndexedDB schema
│   │   └── sync.ts             # Sync system
│   └── stores/                 # Zustand stores
├── features/
│   ├── threads/                # Thread feature
│   ├── documents/              # Document feature
│   └── projects/               # Project feature
├── shared/
│   └── components/             # Shared UI components
└── types/                      # Shared TypeScript types
```
