---
detail: standard
audience: developer
status: in_planning
---

# Loading Foundations & Linger Pattern – Plans

**Status:** In planning  
**Priority:** High (user‑visible polish + architectural clarity)  
**Estimated effort:** 1–2 days (split across both plans)

This document defines two related implementation plans:
- **Plan A – Loading Foundations:** Fix core loading state modelling and skeleton behavior.
- **Plan B – Prefer Linger Pattern:** Introduce a SOLID, repeatable pattern so most views *linger* on the previous data until new data is ready.

Both plans are incremental and local-first friendly; they build on the existing Dexie + cache policy system and Zustand stores.

---

## Context & Goals

Current UX problems:
- Users see **loading flashes** (skeletons or “Loading…” badges) even when cached data exists (projects list, document tree, chat list, chat messages).
- Some components use a single `isLoading` flag with **overloaded meaning**:
  - “we have no data yet” (cold load)
  - “we are refreshing existing data” (warm cache)
  - “we are mutating” (create/update/delete)
- Document and chat switching feel **jumpy**, especially when URL changes are involved.

We already have strong foundations:
- **Database:** Postgres schema models the core hierarchy and chat system:
  - Projects, folders, documents (`backend/migrations/00001_initial_schema.sql`).
  - Chats, turns, turn_blocks with full metadata and FTS indexes.
- **Local cache:** Dexie (`frontend/src/core/lib/db.ts`) with:
  - `documents` table keyed by `id, projectId, folderId, updatedAt`.
  - `chats` and `messages` tables for chat metadata and windowed messages.
- **Cache policies:** `ReconcileNewestPolicy`, `NetworkFirstPolicy`, and `StaleWhileRevalidatePolicy` in `frontend/src/core/lib/cache.ts`.
  - Already used by `useEditorStore` for document content.

The plans below focus on:
1. Making **loading states explicit and correct** (when to show skeletons vs data).
2. Implementing a **“prefer linger” pattern** for navigation:
   - Stay on previous header + content until new data is ready.
   - Switch header + content together, in one commit.

---

# Plan A – Loading Foundations (State, Skeletons, Cache)

**Goal:** Eliminate unnecessary loading flashes by fixing the core loading model and cache usage, starting with projects and creating a pattern for other stores.

## Problem Statement

Today:
- Stores often expose only `isLoading` and `error`.
- Components show skeletons whenever `isLoading === true`, even if cached data exists (e.g. projects from localStorage).
- Skeleton color (`bg-accent`) is visually “loud”, making even short flashes noticeable.

We want:
- A **clear state machine** for “no data vs cached vs refreshing”.
- Skeletons only when there is truly **no usable data yet**.
- Neutral, minimal skeleton visuals across the app.

## Current State

Key pieces:
- `useProjectStore` (`frontend/src/core/stores/useProjectStore.ts`)
  - Persists `projects` and `currentProjectId` via Zustand `persist`.
  - Uses `isLoading` + `error`.
  - `loadProjects()` always sets `isLoading=true` at start, causing skeletons even with cache.
- `ProjectsPage` (`frontend/src/app/projects/page.tsx`)
  - Renders a 3-card skeleton whenever `isLoading` is true.
- `useTreeStore` (`frontend/src/core/stores/useTreeStore.ts`)
  - Network-first `loadTree(projectId)` that:
    - Fetches tree from API.
    - Caches full documents (with content) into Dexie.
    - Always sets `isLoading=true` at start.
  - No tree read from Dexie; tree view is effectively network-bound.
- `useChatStore` (`frontend/src/core/stores/useChatStore.ts`)
  - Persists nothing (`partialize: () => ({})`).
  - `loadChats(projectId)` is pure network-first; no local cache for chat list.
- `MeridianDB` (`frontend/src/core/lib/db.ts`)
  - Has `documents`, `chats`, `messages` tables; no `folders` table yet.
- `Skeleton` + `CardSkeleton` (`frontend/src/shared/components/ui/skeleton.tsx`, `frontend/src/shared/components/ui/card.tsx`)
  - Skeleton base uses `bg-accent animate-pulse`, which is visually bright.

## Architecture Context

Backend:
- Projects, folders, documents are modeled relationally with foreign keys and indexes.
- Chats and turns are tightly bound to projects and users, with `chat.project_id` and `turns.chat_id`.

Frontend:
- **Persistence layers:**
  - `useProjectStore` → localStorage via Zustand `persist` (metadata, small data).
  - `MeridianDB` → Dexie for documents, chats, messages (heavier, offline-friendly).
- **Policies (`cache.ts`):**
  - `ReconcileNewestPolicy<T>`: cache-first + reconcile by `updatedAt`.
  - `NetworkFirstPolicy<T>`: network-first with cache fallback.
  - `StaleWhileRevalidatePolicy<T>`: ideal for lists (trees, chat lists, project lists).

Plan A will:
- Standardize a **state machine pattern** on top of these.
- Start using Dexie-backed or persist-backed caches consistently before network.

## Implementation Plan – Plan A

### Phase A1 – Skeleton Visual Tuning (Quick Win)

**Files:**
- `frontend/src/shared/components/ui/skeleton.tsx`

**Changes:**
- Replace `bg-accent` with a neutral token such as `bg-muted` (or `bg-skeleton` if we add one later).
- Keep `animate-pulse`, but confirm it’s subtle enough in both light and dark themes.

**Why:**
- Reduces perceived flash intensity globally, independent of state changes.

**Testing:**
- Visual check:
  - Projects page.
  - Document tree.
  - Editor skeleton sections.

---

### Phase A2 – Standard Loading State Model (Project Store POC)

**Files:**
- `frontend/src/core/stores/useProjectStore.ts`
- `frontend/src/app/projects/page.tsx`

**State model:**

```ts
type LoadStatus = 'idle' | 'loading' | 'success' | 'error'

interface ProjectStore {
  projects: Project[]
  currentProjectId: string | null
  status: LoadStatus        // controls skeleton/error visibility
  isFetching: boolean       // true whenever a network request is in flight
  error: string | null
  // existing methods unchanged: loadProjects, createProject, etc.
}
```

**`loadProjects()` semantics:**
- At start:
  - If `projects.length === 0`:
    - `status = 'loading'` (true cold load → skeleton OK).
  - Else:
    - `status = 'success'` (we have cache, show it).
  - Always: `isFetching = true`, `error = null`.
- On success:
  - Update `projects`.
  - `status = 'success'`, `isFetching = false`, `error = null`.
- On error:
  - If `projects.length > 0` (cached data present):
    - Keep `status = 'success'`.
    - Set `isFetching = false`, `error = <message>`.
  - If no cached data:
    - `status = 'error'`, `isFetching = false`, `error = <message>`.

**Persist config:**

```ts
persist(
  (set, get) => ({ ... }),
  {
    name: 'project-store',
    partialize: (state) => ({
      currentProjectId: state.currentProjectId,
      projects: state.projects,
      // status / isFetching / error intentionally not persisted
    }),
  }
)
```

**Why:**
- `status` is a view concern; it should recompute from cached data on hydration.
- Prevents “stuck loading” or “stuck error” after reload.

---

### Phase A3 – ProjectsPage Wiring

**File:**
- `frontend/src/app/projects/page.tsx`

**New behavior:**

```ts
const { projects, status, isFetching, error, loadProjects } = useProjectStore()

useEffect(() => {
  loadProjects()
}, [loadProjects])

if (status === 'loading') {
  return <SkeletonLayout />        // true cold load only
}

if (status === 'error' && projects.length === 0) {
  return <ErrorPanel ... />
}

return (
  <PageLayout>
    {/* optional subtle refresh indicator when isFetching === true */}
    <ProjectList projects={projects} />
  </PageLayout>
)
```

**Why:**
- Cached projects (from localStorage) render immediately with no skeleton flash.
- Skeleton appears only for first-ever loads or after a hard cache purge.

---

### Phase A4 – Document Tree & Chat List Foundations

This phase aligns other stores with the same loading model and prepares for Plan B’s “linger” behavior.

**Files:**
- `frontend/src/core/stores/useTreeStore.ts`
- `frontend/src/features/documents/components/DocumentTreeContainer.tsx`
- `frontend/src/core/stores/useChatStore.ts` (list portion)
- `frontend/src/features/chats/hooks/useChatsForProject.ts`
- `frontend/src/features/chats/components/ChatListPanel.tsx`

**Changes (conceptual):**

1. **`useTreeStore`**
   - Introduce `status: LoadStatus`, `isFetching`, `error`.
   - Avoid clearing `documents`, `folders`, `tree` at the start of `loadTree`.
   - Set:
     - `status='loading'` only when no tree data exists for the project.
     - `status='success'` + `isFetching=true` when revalidating an existing tree.
   - Update `DocumentTreeContainer`:
     - Show skeleton only when `status === 'loading'`.
     - Show `ErrorPanel` only when `status === 'error'` and tree is empty.

2. **`useChatStore` (chat list)**
   - Introduce `statusChats: LoadStatus`, `isFetchingChats`, `error`.
   - Optionally persist:

   ```ts
   partialize: (state) => ({
     chats: state.chats,
     currentProjectId: state.currentProjectId, // new field
   })
   ```

   - Update `loadChats(projectId)` to use the same state machine:
     - Keep existing chats visible while `isFetchingChats = true`.
   - `useChatsForProject(projectId)`:
     - Filter chats by `currentProjectId` so we don’t leak chats across projects.

3. **ChatListPanel**
   - Render:
     - Chat list if any chats for this project.
     - `ChatListEmpty` only when there are truly no chats for this project.
   - No skeleton needed once `statusChats` is respected.

---

### Phase A5 – Validation & Testing

**Scenarios (per feature):**
- Cold start (no localStorage/Dexie) → skeleton, then data.
- Warm start (data cached) → immediate data, silent background fetch (no skeleton).
- Network error with cache → stale data remains visible, error surfaced (toast or inline).
- Network error without cache → error panel with retry.

**Success Criteria (Plan A):**
- Projects page shows **no skeleton** when cached projects exist.
- Document tree & chat list:
  - Only show skeleton or hard “Loading…” when there is no cached data at all.
  - Never flicker between skeleton and data on warm reloads.
- Skeleton visuals are neutral and minimal.

---

# Plan B – Prefer Linger Pattern (Navigation & Stores)

**Goal:** Implement a repeatable, SOLID pattern where most views *linger* on previous data (header + content) until the new data is ready, then switch in a single commit.

## Problem Statement

Current behavior:
- On chat or document switch:
  - Header and body can switch early, before new data is ready.
  - Center panel may show “Loading…” overlays or skeletons for a brief period.
  - User sees visual “flashes”, even when caches could have avoided them.
- For document switching, the URL is the driver:
  - `initialDocumentId` in `WorkspaceLayout` updates instantly on navigation.
  - The UI tries to follow synchronously, leading to races and flashes.

Desired behavior:
- **Prefer linger:** keep showing previous chat/document (header + content) while new data is loading.
- When new data is ready (from cache or server), commit the switch:
  - Header + body swap together.
  - No intermediate “blank” or “loading” state for warm navigations.

## Architecture Context

Key components:
- `useUIStore` (`frontend/src/core/stores/useUIStore.ts`)
  - Tracks `activeDocumentId`, `rightPanelState`, `activeChatId`, etc.
  - Effect in `WorkspaceLayout` syncs `initialDocumentId` ↔ `activeDocumentId` (URL ↔ UI).
- `WorkspaceLayout` (`frontend/src/app/projects/[id]/components/WorkspaceLayout.tsx`)
  - Uses `initialDocumentId` from route params.
  - Loads tree in background for deep links.
  - Uses `useUIStore` for panel state and active document.
- `useEditorStore` + `EditorPanel` (`frontend/src/core/stores/useEditorStore.ts`, `frontend/src/features/documents/components/EditorPanel.tsx`)
  - Already implement cache-first document loading via Dexie + `ReconcileNewestPolicy`.
  - Editor uses `useEditorCache` for in-memory TipTap instance reuse.
- `useChatStore`, `useTurnsForChat`, `ActiveChatView` for chat center panel.

Plan B defines a **pending → visible** pattern on top of these.

## Core Pattern – Pending vs Visible Selection

For any “selected item that drives a view” (chat, document, etc.), we separate:
- `visibleXId`: what the UI is currently showing (header + content).
- `pendingXId`: what the user or URL *intends* to show next.

Rules:
- When the user clicks a new item or the URL changes:
  - Update `pendingXId`, **do not** change `visibleXId` yet.
- Start loading data for `pendingXId` (from Dexie + server).
- When data is ready:
  - Commit: set `visibleXId = pendingXId`, clear `pendingXId`.
  - Only at this moment does the UI switch header + content.
- On error/abort:
  - Keep `visibleXId` as-is (linger on previous view).
  - Clear or keep `pendingXId` as appropriate; show error (toast or inline).

This pattern:
- Ensures header + body **never show mismatched items**.
- Makes “linger” the default behavior when switching between items.

## Implementation Plan – Plan B

### Phase B1 – UI Store Extensions

**File:**
- `frontend/src/core/stores/useUIStore.ts`

**Changes:**
- For documents:

```ts
visibleDocumentId: string | null
pendingDocumentId: string | null
setPendingDocument: (id: string | null) => void
commitDocument: (id: string | null) => void
```

- For chats:

```ts
visibleChatId: string | null
pendingChatId: string | null
setPendingChat: (id: string | null) => void
commitChat: (id: string | null) => void
```

**Why:**
- Centralized “intent vs visible” modelling.
- Keeps navigation semantics in one place, aligning with the navigation pattern doc.

---

### Phase B2 – URL-Driven Document Switching (Prefer Linger)

**Files:**
- `frontend/src/app/projects/[id]/components/WorkspaceLayout.tsx`
- `frontend/src/features/documents/components/DocumentPanel.tsx`
- `frontend/src/features/documents/components/DocumentTreeContainer.tsx`

**Behavior:**
1. **WorkspaceLayout URL effect:**
   - When `initialDocumentId` changes:

   ```ts
   useEffect(() => {
     const store = useUIStore.getState()
     store.setPendingDocument(initialDocumentId ?? null)
     // rightPanelState sync remains as in navigation-pattern doc
   }, [initialDocumentId])
   ```

   - Note: `visibleDocumentId` is **not** changed here.

2. **Coordinator (DocumentPanel or WorkspaceLayout):**
   - Watch `pendingDocumentId`.
   - When `pendingDocumentId = D`:
     - Call `loadDocument(D, signal)` from `useEditorStore`.
     - Let `useEditorStore` use Dexie + `ReconcileNewestPolicy` to emit cached data early.
   - Once `loadDocument` resolves successfully (or once we know `activeDocument.id === D` and editor is initialized):
     - Call `commitDocument(D)`.

3. **EditorPanel rendering:**
   - `DocumentPanel` passes `visibleDocumentId` to `EditorPanel`.
   - `EditorPanel` uses `visibleDocumentId` as today’s `documentId` prop:
     - Header + content are always in sync.
   - Skeleton:
     - Only when there is no `visibleDocumentId` *and* no cached document (true cold load / deep link).

**Why:**
- URL remains the source of truth for intent.
- UI only switches visible document when the new content is ready, eliminating flashes during warm navigations.

---

### Phase B3 – Chat Linger Pattern

**Files:**
- `frontend/src/features/chats/components/ChatListPanel.tsx`
- `frontend/src/features/chats/components/ActiveChatView.tsx`
- `frontend/src/features/chats/hooks/useChatsForProject.ts`
- `frontend/src/features/chats/hooks/useTurnsForChat.ts`
- `frontend/src/core/stores/useChatStore.ts` (for turns loading, if needed)

**Behavior:**

1. **ChatListPanel:**
   - On chat click:

   ```ts
   const { setPendingChat } = useUIStore(...)

   const handleSelectChat = (chatId: string) => {
     setPendingChat(chatId)
   }
   ```

   - Visual selection:
     - You may choose to highlight `pendingChatId`, or keep `visibleChatId` highlighted; this is a UX choice.

2. **useTurnsForChat / coordinator:**
   - Accept `pendingChatId` (instead of `activeChatId`) as input.
   - When `pendingChatId = C`:
     - Call `openChat(C, signal)` in `useChatStore`.
     - `openChat` uses network-first (for now), but future work can add Dexie-backed windowed `messages` cache.
   - Once `openChat` resolves successfully and local `turns` are populated:
     - Call `commitChat(C)` in `useUIStore`.

3. **ActiveChatView:**
   - Read `visibleChatId` from `useUIStore`.
   - Derive header and messages **only** from `visibleChatId`:
     - Header uses the chat whose `id === visibleChatId`.
     - `useTurnsForChat` aligns its returned `turns` with `visibleChatId` after commit.
   - “Loading…” badge:
     - Optional; can be removed entirely for warm navigations.
     - If kept, it should appear inline over the **previous** chat while the new one loads, not as a full-screen flash.

**Why:**
- Chat title and turns always belong to the same chat id.
- Switching chats is visually smooth: previous chat lingers until the new one is ready.

---

### Phase B4 – Generalizing the Pattern (Reusable Helper)

Optionally, we can define a small, reusable helper for “pending vs visible” patterns to keep SOLID and DRY:

**File (new):**
- `frontend/src/core/lib/pendingSelection.ts` (or a similar name)

**Concept:**

```ts
interface PendingSelection<TId> {
  visibleId: TId | null
  pendingId: TId | null
  setPending(id: TId | null): void
  commit(id: TId | null): void
}
```

The actual storage remains in `useUIStore`, but the pattern and semantics are documented and consistent. This makes it easier to:
- Add future “linger” behaviors (e.g. for other panels).
- Keep the intent clear for any contributor or future AI agent.

---

### Phase B5 – Testing & Validation

**Scenarios:**
- Document switching via:
  - Clicking in the tree.
  - Clicking in breadcrumbs / internal links.
  - Browser back/forward between documents.
- Chat switching via:
  - Clicking different chats in the list.
  - Rapidly switching back and forth.
- In all cases:
  - Previous view lingers until new data is ready.
  - No transient full-page skeleton / “Loading…” overlay on warm navigations.
  - Header + body always reflect the same chat/document id.

**Success Criteria (Plan B):**
- Document and chat switches are visually smooth:
  - Old content remains visible until new content is ready.
  - Header and content update together, never mismatched.
- Skeletons are only seen on true cold loads or deep links with no cache.
- The “pending vs visible” pattern is localized in `useUIStore` and documented, making it easy to reuse.

---

## Related Documentation

- `_docs/plans/README.md` – Plan structure and conventions.
- `_docs/technical/frontend/editor-caching.md` – Detailed document loading & caching flows.
- `_docs/technical/frontend/architecture/navigation-pattern.md` – URL ↔ UI sync pattern in the workspace.
- `frontend/src/core/lib/cache.ts` – Cache policies (ReconcileNewest, NetworkFirst, StaleWhileRevalidate).
- `frontend/src/core/lib/db.ts` – Dexie schema (`documents`, `chats`, `messages`).

