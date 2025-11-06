# Frontend CLAUDE.md

Instructions for Claude Code when working with the Meridian frontend.

See main `CLAUDE.md` for general principles. This document focuses on frontend-specific patterns.

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **State Management**: Zustand with persist middleware
- **Local Database**: Dexie (IndexedDB wrapper)
- **Editor**: TipTap (ProseMirror-based rich text editor)
- **Styling**: Tailwind CSS
- **UI Components**: Radix UI + shadcn/ui

## Development Commands

```bash
npm run dev         # Start dev server (http://localhost:3000)
npm run build       # Production build
npm run type-check  # TypeScript type checking
```

## Architecture Overview

### Caching Strategy

Three distinct caching patterns based on data characteristics:

#### 1. Documents (Reconcile-Newest)
**Pattern**: Always fetch server; compare with cache by `updatedAt`; render newest
- Emit cached content immediately if present (read-only), reconcile with server
- Optimistic updates + retry on network failure
- **Implementation**: `useEditorStore.ts`
- **Utilities**: `loadWithPolicy(new ReconcileNewestPolicy())` in `core/lib/cache.ts`

#### 2. Chats/Messages (Network-First)
**Pattern**: Server is source of truth, cache is fallback
- Fetch from API first → update IndexedDB
- On network error: fallback to IndexedDB if available
- Windowed caching for messages (last 100 only)
- **Implementation**: `useChatStore.ts`
- **Utilities**: `loadWithPolicy(new NetworkFirstPolicy())`, `windowedCacheUpdate()` in `core/lib/cache.ts`

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

### Sync System

**Location**: `frontend/src/core/lib/sync.ts`

Simplified direct sync (no persistent queue):
1. Save to IndexedDB first (instant feedback)
2. Sync directly to API
3. On network error: Add to in-memory retry queue (max 3 attempts, 5s delay)
4. On client error (4xx): Show error modal, allow manual retry
5. Always apply server response (source of truth for timestamps)

**Background processing**: Only the retry processor runs (every 5s). No other background listeners.

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
**Extensions**:
- StarterKit (core functionality)
- CharacterCount (word/character counting)
- Placeholder (empty state)
- Highlight, Typography

**Word count**: Use `editor.storage.characterCount.words()` (not manual HTML parsing)

### Error Handling
- Network errors (5xx, timeout, fetch fail): Automatic retry
- Client errors (4xx, validation): Show error, manual retry only
- Abort errors: Silent (user cancelled operation)

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
