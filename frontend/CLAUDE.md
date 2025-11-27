# Frontend CLAUDE.md

Instructions for Claude Code when working with the Meridian frontend.

See main `CLAUDE.md` for general principles. This document focuses on frontend-specific patterns.

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **State Management**: Zustand with persist middleware
- **Local Database**: Dexie (IndexedDB wrapper)
- **Editor**: TipTap (ProseMirror-based rich text editor)
- **Styling**: Tailwind CSS
- **UI Components**: Radix UI + shadcn/ui

## Development Commands

```bash
npm run dev          # Start dev server (http://localhost:3000)
npm run build        # Production build
npm run lint         # ESLint
npm run test         # Vitest unit tests (core libs + services)
npm run test:watch   # Vitest in watch mode
```

## Authentication

**Status**: ✅ Complete (Supabase Auth integration)

**Overview**: Cookie-based sessions with automatic JWT injection into all API calls. Next.js 16 proxy protects routes. Google OAuth only (no email/password).

### Supabase Clients

Two client factories based on context:

1. **Browser Client** (`src/core/supabase/client.ts`) - Use in Client Components
2. **Server Client** (`src/core/supabase/server.ts`) - Use in Server Components, Route Handlers, proxy

### Accessing User Session

**In Client Components**:
```typescript
import { createBrowserSupabaseClient } from '@/core/supabase/client'

const supabase = createBrowserSupabaseClient()
const { data: { session } } = await supabase.auth.getSession()
// session?.user.id, session?.user.email
```

**In Server Components**:
```typescript
import { createServerSupabaseClient } from '@/core/supabase/server'

const supabase = await createServerSupabaseClient()
const { data: { session } } = await supabase.auth.getSession()
```

### Route Protection

**All routes automatically protected** by Next.js 16 proxy (`src/proxy.ts`). No additional code needed in components.

- Unauthenticated users → Redirect to `/login`
- Authenticated users on `/login` or `/` → Redirect to `/projects`

**Note**: Next.js 16 renamed `middleware.ts` to `proxy.ts` to clarify the network boundary concept and avoid confusion with Express.js middleware.

### API Calls

**JWT injection is automatic**. No action needed in components:

```typescript
import { api } from '@/core/lib/api'

// JWT automatically added to Authorization header
const chats = await api.chats.list(projectId)
```

Implementation: `src/core/lib/api.ts:21-27` extracts JWT from session and adds to every request.

### Key Files

- `src/core/supabase/client.ts` - Browser client factory
- `src/core/supabase/server.ts` - Server client factory with cookie handling
- `src/proxy.ts` - Auth proxy (route protection, session refresh)
- `src/core/lib/api.ts` - JWT injection
- `src/app/login/page.tsx` - Login UI
- `src/features/auth/components/LoginForm.tsx` - Google OAuth login button
- `src/app/auth/callback/route.ts` - OAuth callback handler (PKCE flow)

### Environment Variables

Required in `.env.local`:
```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-anon-key
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
- URL sync effect: `frontend/src/app/projects/[id]/components/WorkspaceLayout.tsx:54-102`
- **See**: `_docs/technical/frontend/architecture/navigation-pattern.md` for comprehensive guide

### Sync System

- Core policy + scheduler: `frontend/src/core/lib/cache.ts`, `frontend/src/core/lib/retry.ts`, `frontend/src/core/lib/sync.ts`
- UI-free orchestration service: `frontend/src/core/services/documentSyncService.ts`

Flow (documents):
1) Optimistic write to IndexedDB → 2) direct PATCH to API → 3) apply server doc (server timestamps become canonical once applied). On network/5xx, enqueue in-memory retry (jittered backoff; max attempts). 4xx bubbles to UI for manual retry.

Background: only the retry scheduler (ticked in `SyncProvider`). No visibility/online listeners.

Dev: optional retry inspector in dev builds — set `NEXT_PUBLIC_DEV_TOOLS=1` to enable small bottom-left panel.

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
- Defaults: `debug` in development, `info` in production. Override via `NEXT_PUBLIC_LOG_LEVEL`.

### Testing

- Unit tests live under `frontend/tests/` and run with Vitest.
- Focused coverage for: retry scheduler, cache policies, and `DocumentSyncService`.

### Dev Tools

- Set `NEXT_PUBLIC_DEV_TOOLS=1` to show the Retry panel overlay.

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

### TipTap Editor

**Content Format**:
- **Storage**: Markdown (backend, API, IndexedDB, stores)
- **Editor**: HTML/ProseMirror (TipTap internal representation)
- **Conversion**: At editor boundary in `EditorPanel.tsx`
  - Load: `editor.commands.setContent(markdown, { contentType: 'markdown' })`
  - Save: `editor.getMarkdown()`

**Extensions** (configured in `core/editor/extensions.ts`):
- StarterKit (core functionality)
- Markdown (enables markdown ↔ HTML conversion)
- CharacterCount (word/character counting)
- Placeholder (empty state)
- Highlight, Typography

**Word count**: Use `editor.storage.characterCount.words()` (not manual HTML parsing)

### Error Handling
- Network errors (5xx, timeout, fetch fail): Automatic retry
- Client errors (4xx, validation): Show error, manual retry only
- Abort errors: Silent (user cancelled operation)

Conventions:
- Use `handleApiError(error, fallback)` from `core/lib/errors.ts` in UI/store catch blocks for consistent toasts.
- Use `isAbortError(error)` for early returns on cancelled requests.
- Global UI fallbacks: `app/error.tsx` and `app/global-error.tsx` render an `ErrorPanel` and log via `makeLogger()`.

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
├── app/                        # Next.js App Router pages
├── core/
│   ├── components/             # Core components (SyncProvider)
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
- **Environment**: Production builds via `npm run build`
