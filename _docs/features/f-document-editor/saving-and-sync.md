---
stack: frontend
status: complete
feature: "Saving and Sync"
---

# Saving and Sync

**Auto-save, optimistic updates, and cache-first architecture.**

## Status:  Complete

---

## Auto-Save

**Debounce**: 1 second (trailing edge)

**Trigger**: Any content change in editor

**Flow**:
1. User types ’ debounce timer starts
2. Timer expires ’ save to IndexedDB (immediate)
3. Show "Saving" status
4. Sync to server (background)
5. On success: Show "Saved" + timestamp
6. On error: Show error icon + retry

**File**: `/Users/jimmyyao/gitrepos/meridian/frontend/src/features/documents/components/EditorPanel.tsx:169-175`

---

## Cache Strategy: Reconcile-Newest

**Read Flow**:
1. Check IndexedDB cache first
2. If cached: Show cached content immediately (read-only)
3. Fetch from server in background
4. Compare `updatedAt` timestamps
5. If server newer: Update cache + editor
6. If cache newer or equal: Keep cache
7. Unlock editor for editing

**Write Flow**:
1. Update IndexedDB immediately (optimistic)
2. Sync to server in background
3. On 409 Conflict: Server wins, update cache
4. On 5xx/network error: Retry automatically

**File**: `/Users/jimmyyao/gitrepos/meridian/frontend/src/core/lib/cache.ts`

---

## Sync Service

**File**: `/Users/jimmyyao/gitrepos/meridian/frontend/src/core/services/documentSyncService.ts`

**Features**:
- Retry queue for failed saves
- Exponential backoff with jitter
- Max 5 retry attempts
- 4xx errors ’ show toast, don't retry
- 5xx errors ’ auto-retry

**Retry intervals**: 5s, 10s, 20s, 40s, 80s (with jitter)

---

## Save Status UI

**File**: `/Users/jimmyyao/gitrepos/meridian/frontend/src/features/documents/components/SaveStatusIcon.tsx`

**States**:
-  **Saved** - Checkmark icon + "Last saved: 2m ago"
- ó **Saving** - Spinner + "Saving..."
-   **Error** - Warning icon + "Error saving"

**Timestamp**: Relative time (e.g., "2 minutes ago", "just now")

---

## Conflict Handling

**Server timestamp is canonical**:
- On load: Server `updatedAt` wins if newer
- On save: 409 Conflict ’ fetch server version, update cache
- No manual conflict resolution UI (server always wins)

**Rationale**: Single-user editing, no collaborative conflicts expected

---

## IndexedDB Schema

**Table**: `documents`

**Fields**:
- `id` - Document ID (primary key)
- `name` - Document name
- `content` - Markdown content
- `folderId` - Parent folder ID
- `projectId` - Parent project ID
- `updatedAt` - Server timestamp
- `wordCount` - Calculated word count

**File**: `/Users/jimmyyao/gitrepos/meridian/frontend/src/core/lib/db.ts`

---

## Performance

**Optimistic updates**: UI feels instant (no wait for server)

**Background sync**: User continues working while save happens

**Cache-first reads**: Documents load instantly from cache

---

## Related

- See [tiptap-integration.md](tiptap-integration.md) for editor caching
- See `/_docs/technical/frontend/editor-caching.md` for architecture details
