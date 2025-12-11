# Frontend CLAUDE.md

Instructions for Claude Code when working with the Meridian frontend.

See main `CLAUDE.md` for general principles. This document focuses on frontend-specific patterns.

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
pnpm run test         # Vitest unit tests (core libs + services)
pnpm run test:watch   # Vitest in watch mode
```

## Authentication

**Status**: ✅ Complete (Supabase Auth integration)

**Overview**: Cookie-based sessions with automatic JWT injection into all API calls. TanStack Router handles route protection. Google OAuth only (no email/password).

### Supabase Client

**Browser Client** (`src/core/supabase/client.ts`) - Use throughout the application (Vite is client-side only)

### Accessing User Session

```typescript
import { createClient } from '@/core/supabase/client'

const supabase = createClient()
const { data: { session } } = await supabase.auth.getSession()
// session?.user.id, session?.user.email
```

### Route Protection

Routes use TanStack Router's `beforeLoad` hooks for authentication checks.

- Unauthenticated users → Redirect to `/login`
- Authenticated users on `/login` or `/` → Redirect to `/projects`

### API Calls

**JWT injection is automatic**. No action needed in components:

```typescript
import { api } from '@/core/lib/api'

// JWT automatically added to Authorization header
const chats = await api.chats.list(projectId)
```

Implementation: `src/core/lib/api.ts:21-27` extracts JWT from session and adds to every request.

### Key Files

- `src/core/supabase/client.ts` - Supabase client factory
- `src/core/lib/api.ts` - JWT injection
- `src/routes/login.tsx` - Login route
- `src/features/auth/components/LoginForm.tsx` - Google OAuth login button
- TanStack Router routes with auth guards

### Environment Variables

Required in `.env.local`:
```bash
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-anon-key
```

See `frontend/.env.example` for template.

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

#### 2. Chats/Messages (Network-First)
**Pattern**: Server is source of truth.
- Fetch from API first
- No local caching (Dexie) currently implemented
- **Implementation**: `useChatStore.ts`

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
- **Loading flags**: Separate flags for different operations (e.g., `isLoadingChats`, `isLoadingMessages`)
- **Error handling**: Silent abort errors, show others to user
- **Optimistic updates**: Update local state immediately, sync to server in background

**Stores**:
- `useEditorStore.ts` - Document editing (cache-first)
- `useChatStore.ts` - Chats and messages (network-first with windowing)
- `useProjectStore.ts` - Project list (persist middleware)
- `useTreeStore.ts` - Document tree structure (network-first, bulk cache)
- `useUIStore.ts` - UI state (persist middleware)

### Navigation Pattern

Document and panel navigation uses a **two-pronged approach**:

1. **Direct state updates** via `panelHelpers` (instant feedback, handles same-URL clicks)
2. **URL sync effect** in `WorkspaceLayout` (syncs UI to URL on back/forward/refresh)

**Key pattern**: Use `getState()` in effects to read state without subscribing:
- Prevents unnecessary effect re-runs when state changes
- Allows independent effects (document URL vs chat query params)
- Essential for future chat integration (chat persists across document navigation)

**Implementation:**
- Navigation helpers: `frontend/src/core/lib/panelHelpers.ts`
- URL sync effect: `frontend/src/features/workspace/components/WorkspaceLayout.tsx`
- **See**: `_docs/technical/frontend/architecture/navigation-pattern.md` for comprehensive guide

### Sync System

- Core policy + scheduler: `frontend/src/core/lib/cache.ts`, `frontend/src/core/lib/retry.ts`, `frontend/src/core/lib/sync.ts`
- UI-free orchestration service: `frontend/src/core/services/documentSyncService.ts`

Flow (documents):
1) Optimistic write to IndexedDB → 2) direct PATCH to API → 3) apply server doc (server timestamps become canonical once applied). On network/5xx, enqueue in-memory retry (jittered backoff; max attempts). 4xx bubbles to UI for manual retry.

Background: only the retry scheduler (ticked in `SyncProvider`). No visibility/online listeners.

Dev: optional retry inspector in dev builds — set `VITE_DEV_TOOLS=1` to enable small bottom-left panel.

**See**: `_docs/technical/frontend/architecture/sync-system.md` for detailed sync mechanics and diagrams.

### IndexedDB Schema

**Location**: `frontend/src/core/lib/db.ts`

Current version: 4

**Tables**:
- `documents`: Full documents with content (cache-first)
- `chats`: Chat metadata (network-first)
- `messages`: Chat messages (network-first, windowed to 100)

**Indexes**:
- `documents`: `id, projectId, folderId, updatedAt`
- `chats`: `id, projectId, createdAt`
- `messages`: `id, chatId, createdAt, lastAccessedAt`

**Auto-eviction**: Not implemented yet (YAGNI). Add only when quota issues appear.

### Logging

- Use `frontend/src/core/lib/logger.ts` → `makeLogger('namespace')` with `debug/info/warn/error`.
- Defaults: `debug` in development, `info` in production. Override via `VITE_LOG_LEVEL`.

### Testing

- Unit tests live under `frontend/tests/` and run with Vitest.
- Focused coverage for: retry scheduler, cache policies, and `DocumentSyncService`.

### Dev Tools

- Set `VITE_DEV_TOOLS=1` to show the Retry panel overlay.

## UI Philosophy: Writer-First

Meridian's UI serves the writer's creative process. Everything else is secondary.

### Core Principles

1. **Content gets the most space** - Writing is the star, UI supports it
2. **AI assists, doesn't overwhelm** - Chat is present but compact
3. **Minimal distractions** - Compact controls, calm aesthetic
4. **Flow-supporting design** - Nothing interrupts creative momentum

### Practical Guidelines

- **Compact over spacious**: Use smaller padding/gaps for UI chrome (e.g., `px-1.5 py-1` not `px-4 py-3`)
- **Hierarchy matters**: Content > Chat > Navigation > Settings
- **Progressive disclosure**: Show less by default, reveal on interaction

### Theme System

Flexible theming with runtime switching. Default theme is **Modern Literary** (Slate + Amber).

**Available themes**: `modern-literary` (default), `classic-jade`, `academic`

**Usage**:
```typescript
import { useThemeContext } from '@/core/theme';
const { themeId, setThemeId, isDark, setMode } = useThemeContext();
```

**Key CSS variables**: `--theme-bg`, `--theme-surface`, `--theme-text`, `--theme-accent`, `--theme-font-display`, `--theme-font-body`, `--theme-font-ui`

**Spacing**: 8pt grid (`gap-2` = 8px standard)

**Shadows**: `--theme-shadow-1`, `--theme-shadow-2`, `--theme-shadow-3`

**Full docs**: `_docs/technical/frontend/theme-system.md`

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

**AI Integration** via `AIEditorRef` (from `core/editor/api`):
- `addSuggestion(range, text)`: Add AI suggestion decoration
- `acceptSuggestion(id)`: Accept suggestion
- `rejectSuggestion(id)`: Reject suggestion

### Error Handling
- Network errors (5xx, timeout, fetch fail): Automatic retry
- Client errors (4xx, validation): Show error, manual retry only
- Abort errors: Silent (user cancelled operation)

Conventions:
- Use `handleApiError(error, fallback)` from `core/lib/errors.ts` in UI/store catch blocks for consistent toasts.
- Use `isAbortError(error)` for early returns on cancelled requests.
- Error boundaries handle global errors and log via `makeLogger()`.

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
│   ├── chats/                  # Chat feature
│   ├── documents/              # Document feature
│   └── projects/               # Project feature
├── shared/
│   └── components/             # Shared UI components
└── types/                      # Shared TypeScript types
```

## Testing

- User runs tests manually
- Claude can suggest test commands
- Claude can help write/fix tests

## Deployment

- **Platform**: Vercel (future)
- **Environment**: Production builds via `pnpm run build`
