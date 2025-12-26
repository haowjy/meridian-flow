# Phase 4: State & Sync

## Goal

Implement save logic that parses the merged document back to `content` and `aiVersion` for storage.

## What You're Building

A save flow that:
1. Takes the merged document from the editor
2. Parses it to extract `content` and `aiVersion`
3. Saves `content` and `aiVersion` via `PATCH /api/documents/{id}` (single request)

```
Editor Document (merged)
        │
        ▼ parseMergedDocument()
┌───────────────────────────┐
│ content: "She felt sad."  │
│ aiVersion: "A heavy..."   │
│ hasChanges: true          │
└───────────────────────────┘
        │
        ▼ API PATCH (single request)
┌───────────────────────────┐
│ Database (clean markdown) │
└───────────────────────────┘
```

## Key Architecture Points

### The Merged Document IS the Source of Truth

During editing, the merged document in CodeMirror contains everything:
- Original text (in DEL regions)
- AI text (in INS regions)
- Unchanged text (outside hunks)

We only parse it back to `content`/`aiVersion` when saving.

### Tri-State Semantics for aiVersion

Per project rule "empty string is valid data":

| Value | Meaning | JSON Sent |
|-------|---------|-----------|
| `undefined` | Don't change | Field omitted |
| `null` | Clear (user rejected all/closed AI) | `null` |
| `""` (empty string) | AI suggests empty doc | `""` |
| `"text..."` | AI suggestion | `"text..."` |

**When `parseMergedDocument()` returns `hasChanges: false`:**
- No markers remain → AI session is complete
- Save behavior depends on server state (see below)

**When to PATCH `ai_version` (important):**
- If the editor document still has markers (`hasChanges: true`): PATCH `ai_version` as a **string** (including `""`) + `ai_version_base_rev`.
- If the editor document has **no markers** (`hasChanges: false`) but the server still has AI open (`document.aiVersion !== null`): PATCH `ai_version: null` **once** + `ai_version_base_rev` to close the AI session.
- If the editor document has **no markers** and the server already has `ai_version = null`: omit `ai_version` entirely (content-only saves).

### Concurrency: Prevent Stomping Unseen AI Updates

AI can update `aiVersion` asynchronously while the user is reviewing or editing. If we blindly PATCH `ai_version` from the client, we can overwrite a newer server `ai_version` the user hasn't seen yet.

Add a lightweight compare-and-swap token:

| Field | Type | Purpose |
|---|---|---|
| `ai_version_rev` | integer | Server-owned revision counter for `ai_version` |

Rules:
- Any time `ai_version` changes (AI tool writes or user sets/clears via PATCH), increment `ai_version_rev`.
- Any PATCH that includes `ai_version` must also include `ai_version_base_rev` (the last `ai_version_rev` the client saw).
- If `ai_version_base_rev` != current `ai_version_rev`, return `409 Conflict` and do **not** apply the `ai_version` change.

This is **not** a 3rd copy of the document; it’s just a revision counter to avoid last-writer-wins on `ai_version`.

### Rev-Bump Checklist (easy to miss)

For the compare-and-swap token to be meaningful, **every** code path that changes `ai_version` must also bump `ai_version_rev`:

- `PATCH /api/documents/{id}` when `ai_version` is present (set or clear)
- The server-side AI writer (e.g. `doc_edit` tool / any LLM pipeline that writes AI suggestions into `documents.ai_version`)
- Any other endpoint/method that directly updates `ai_version` (if present in your backend)

If any writer forgets to bump, clients can “successfully” PATCH with a stale base rev and overwrite unseen server updates.

### No-op AI Versions (AI exists but no diff)

If `ai_version` exists but `buildMergedDocument(content, aiVersion)` contains **no markers** (strings are identical), treat this as “AI session already resolved”:
- Diff UI remains hidden (no markers).
- Best-effort clear `ai_version` with CAS (`ai_version:null` + `ai_version_base_rev`) when the editor is not dirty, so AI doesn’t get stuck on.

## Steps

### Step 4.0: Backend Update (Required)

Complete `00-backend-contract.md` first. This phase assumes:
- Document DTO includes `ai_version_rev` → mapped to `document.aiVersionRev`
- PATCH supports tri-state `ai_version` (undefined/null/string) + `ai_version_base_rev` CAS
- `409 Conflict` uses a typed error code (`ai_version_conflict`) and includes the current document snapshot

---

### Step 4.1: Update the API client

Update `frontend/src/core/lib/api.ts`:

```typescript
documents: {
  // ... existing methods ...

  /**
   * Update document with optional content and/or ai_version.
   *
   * Tri-state aiVersion:
   * - undefined: omit field (no change)
   * - null: clear ai_version
   * - string (including ""): set ai_version
   *
   * Concurrency: if aiVersion is provided, aiVersionBaseRev is required.
   */
  update: async (
    id: string,
    updates: { content?: string; aiVersion?: string | null; aiVersionBaseRev?: number },
    options?: { signal?: AbortSignal }
  ): Promise<Document> => {
    const body: Record<string, unknown> = {}
    if (updates.content !== undefined) body.content = updates.content
    if (updates.aiVersion !== undefined) {
      if (updates.aiVersionBaseRev === undefined) {
        throw new Error('aiVersionBaseRev is required when aiVersion is provided')
      }
      body.ai_version = updates.aiVersion
      body.ai_version_base_rev = updates.aiVersionBaseRev
    }

    const data = await fetchAPI<DocumentDto>(`/api/documents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
      signal: options?.signal,
    })
    return fromDocumentDto(data)
  },
}
```

Also update the document DTO + mapper to carry the revision:
- `frontend/src/types/api.ts`: add `ai_version_rev: number` to `DocumentDto`
- `fromDocumentDto(...)`: map to `document.aiVersionRev`

---

### Step 4.2: Create the save helper

Create `frontend/src/features/documents/utils/saveMergedDocument.ts`:

```typescript
import { parseMergedDocument } from './mergedDocument'
import { api } from '@/core/lib/api'
import { db } from '@/core/lib/db'
import type { Document } from '@/types'

export interface SaveMergedResult {
  /** The saved document from server */
  document: Document
  /** Whether the document still has AI changes */
  hasChanges: boolean
}

export interface SaveMergedOptions {
  /** Last ai_version_rev the client hydrated from (required if we PATCH ai_version) */
  aiVersionBaseRev: number
  /**
   * Whether the last known server snapshot has AI open.
   * Used to decide whether we need a one-time PATCH `ai_version: null` when markers are gone.
   */
  serverHasAIVersion: boolean
  signal?: AbortSignal
}

/**
 * Save a merged document to storage.
 *
 * Parses the merged document to extract content and aiVersion,
 * then saves both in a single API call.
 *
 * @param documentId - The document ID
 * @param merged - The merged document with PUA markers
 * @returns Save result with server document and hasChanges flag
 */
export async function saveMergedDocument(
  documentId: string,
  merged: string,
  options: SaveMergedOptions
): Promise<SaveMergedResult> {
  // Parse merged document to extract content and aiVersion
  const parsed = parseMergedDocument(merged)

  // Build update payload.
  // IMPORTANT: Only PATCH ai_version when needed:
  // - has markers => PATCH ai_version as a string
  // - no markers + server still open => PATCH ai_version:null once to close
  // - no markers + server already closed => omit ai_version entirely
  const updates: {
    content: string
    aiVersion?: string | null
    aiVersionBaseRev?: number
  } = { content: parsed.content }

  if (parsed.hasChanges) {
    updates.aiVersion = parsed.aiVersion
    updates.aiVersionBaseRev = options.aiVersionBaseRev
  } else if (options.serverHasAIVersion) {
    updates.aiVersion = null
    updates.aiVersionBaseRev = options.aiVersionBaseRev
  }

  // Optimistic update to IndexedDB
  // NOTE: Use null (not undefined) to clear aiVersion - Dexie ignores undefined fields
  const now = new Date()
  await db.documents.update(documentId, {
    content: parsed.content,
    // Mirror server intent:
    // - has markers => keep aiVersion in local cache
    // - no markers => clear in local cache
    // (The server may already be closed; clearing locally is still correct UX.)
    aiVersion: parsed.hasChanges ? parsed.aiVersion : null,
    updatedAt: now,
  })

  // Save to server (single request)
  const document = await api.documents.update(documentId, updates, { signal: options.signal })

  return {
    document,
    hasChanges: parsed.hasChanges,
  }
}
```

Note: `saveMergedDocument(...)` can be used as the “diff workflow” save path; it decides whether to PATCH `ai_version` (string/null) or omit it entirely based on markers + `serverHasAIVersion`.

---

### Step 4.3: Update the DocumentSyncService

Update `frontend/src/core/services/documentSyncService.ts`:

Add a method for saving merged documents:

```typescript
import { saveMergedDocument, type SaveMergedResult } from '@/features/documents/utils/saveMergedDocument'

/**
 * Save a merged document (with PUA markers).
 *
 * Parses the document to extract content/aiVersion and saves both.
 * If no markers remain, clears aiVersion (AI session complete).
 */
async saveMerged(
  documentId: string,
  merged: string,
  options: { aiVersionBaseRev: number; serverHasAIVersion: boolean },
  cbs?: {
    onServerSaved?: (result: SaveMergedResult) => void
    onAIVersionConflict?: (serverDocument?: Document) => void
    onRetryScheduled?: () => void
    onError?: (error: Error) => void
  }
): Promise<void> {
  // Cancel any pending retries for this document
  cancelDocumentPatchRetry(documentId)

  try {
    const result = await saveMergedDocument(documentId, merged, {
      aiVersionBaseRev: options.aiVersionBaseRev,
      serverHasAIVersion: options.serverHasAIVersion,
    })
    cbs?.onServerSaved?.(result)
  } catch (error) {
    if (isAbortError(error)) {
      return  // Cancelled, no action needed
    }
    if (isNetworkError(error)) {
      // For now, just report error. Full retry support can be added later.
      // The merged document is already in IndexedDB for recovery.
      cbs?.onRetryScheduled?.()
      return
    }
    if (isConflictError(error)) {
      // ai_version_rev mismatch: server has a newer ai_version than the client saw.
      // Do not retry blindly; surface to UI so user can refresh from server.
      cbs?.onAIVersionConflict?.(extractDocumentFromConflict(error))
      return
    }
    cbs?.onError?.(error as Error)
    throw error
  }
}
```

---

### Step 4.4: Extend the editor store

Update `frontend/src/core/stores/useEditorStore.ts`:

Add state for diff review UI:

```typescript
interface EditorStore {
  // ... existing fields ...

  // Diff review UI state
  /** Currently focused hunk index (for keyboard navigation) */
  focusedHunkIndex: number

  /** Set focused hunk index */
  setFocusedHunkIndex: (index: number) => void

  /** Navigate to next/previous hunk */
  navigateHunk: (direction: 'next' | 'prev', totalHunks: number) => void

  /** Update the active document with server response */
  updateActiveDocument: (document: Document) => void
}
```

Add the implementations:

```typescript
export const useEditorStore = create<EditorStore>()((set, get) => ({
  // ... existing state and actions ...

  // New state
  focusedHunkIndex: 0,

  setFocusedHunkIndex: (index) => set({ focusedHunkIndex: index }),

  navigateHunk: (direction, totalHunks) => {
    if (totalHunks === 0) return

    set((state) => {
      const current = state.focusedHunkIndex
      let next: number

      if (direction === 'next') {
        next = current >= totalHunks - 1 ? 0 : current + 1
      } else {
        next = current <= 0 ? totalHunks - 1 : current - 1
      }

      return { focusedHunkIndex: next }
    })
  },

  updateActiveDocument: (document) => set((state) => {
    // Only update if still viewing the same document
    if (state._activeDocumentId !== document.id) return state
    return { activeDocument: document }
  }),
}))
```

---

## Understanding the Save Flow

```
┌───────────────────────────────────────────────────────────────┐
│  Editor: Merged Document                                       │
│  "\uE000She felt sad.\uE001\uE002A heavy melancholia.\uE003..." │
└───────────────────────────────────────────────────────────────┘
                        │
                        │ Debounce triggers save
                        ▼
              ┌─────────────────────┐
              │ parseMergedDocument │
              └─────────────────────┘
                        │
              ┌─────────┴─────────┐
              ▼                   ▼
    ┌──────────────────┐ ┌──────────────────┐
    │ content:         │ │ aiVersion:       │
    │ "She felt sad."  │ │ "A heavy..."     │
    └──────────────────┘ └──────────────────┘
                        │
                        ▼
              ┌─────────────────────┐
              │  API PATCH (both)   │
              └─────────────────────┘
                        │
                        ▼
              ┌─────────────────────┐
              │  Database (clean)   │
              └─────────────────────┘
```

**After Accept All:**
```
┌──────────────────────────────────────┐
│  Editor: "A heavy melancholia. ..."  │  ← No markers
└──────────────────────────────────────┘
                │
                │ parseMergedDocument()
                ▼
      content: "A heavy melancholia. ..."
      aiVersion: null  ← Cleared (hasChanges: false)
```

---

## When Save Happens

The existing debounce pattern continues to work:

1. User types → `onChange` callback fires
2. `localContent` state updates
3. Debounce (1 second) settles
4. Save triggers with merged document
5. Parse and send to API

The only change: we parse the merged document instead of sending content directly.

---

## Verification Checklist

Before moving to Phase 5, verify:

- [ ] Backend `PATCH /api/documents/{id}` supports `ai_version` (absent/null/string)
- [ ] `api.documents.update()` supports tri-state aiVersion (undefined/null/string)
- [ ] `saveMergedDocument()` correctly parses and saves
- [ ] `documentSyncService.saveMerged()` handles save flow
- [ ] Store has `focusedHunkIndex` and navigation
- [ ] After accept all: `aiVersion` becomes `null`
- [ ] After reject all: `content` restored, `aiVersion` becomes `null`
- [ ] After last hunk resolved via per-hunk ✓/✕: a save sends `aiVersion: null` once (if server was still open)
- [ ] After AI is already closed and no markers remain: content saves omit `aiVersion` entirely (no repeated nulling)
- [ ] Empty string `""` content/aiVersion handled correctly (not treated as falsy)

## Files Modified/Created

| File | Action |
|------|--------|
| `frontend/src/core/lib/api.ts` | Modified |
| `frontend/src/features/documents/utils/saveMergedDocument.ts` | Created |
| `frontend/src/core/services/documentSyncService.ts` | Modified |
| `frontend/src/core/stores/useEditorStore.ts` | Modified |

## Related: Error Handling Utilities

See `04a-conflict-error-handling.md` for implementing `isConflictError()` and `extractDocumentFromConflict()` utilities.

## Next Step

→ Continue to `05-ui-components.md` to build the navigator pill and hunk action buttons.
