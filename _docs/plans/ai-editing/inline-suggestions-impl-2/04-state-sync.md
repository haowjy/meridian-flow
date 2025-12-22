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
- Send `aiVersion: null` to clear it in storage

## Steps

### Step 4.0: Backend Update (Required)

Update the backend so `PATCH /api/documents/{id}` can also update `ai_version`.

**Goal:** keep the editor save path simple + atomic at the HTTP layer: one request updates both `content` and `ai_version`.

#### Tri-state semantics (required)
- **absent** → don’t change `ai_version`
- **null** → clear `ai_version` (set NULL)
- **string (including `\"\"`)** → set `ai_version` to that value

Go note: `encoding/json` cannot distinguish **absent vs null** using pointer fields (both end up as `nil`). Use a value-type wrapper that tracks whether the field was present during unmarshal.

Create `backend/internal/httputil/optional_string.go`:

```go
package httputil

import (
  "bytes"
  "encoding/json"
)

// OptionalString distinguishes:
// - field absent (Present == false)          => no change
// - field present with null ("null")         => clear
// - field present with string (incl "")      => set
type OptionalString struct {
  Present bool
  IsNull   bool
  Value    string
}

func (o *OptionalString) UnmarshalJSON(data []byte) error {
  o.Present = true
  if bytes.Equal(data, []byte("null")) {
    o.IsNull = true
    o.Value = ""
    return nil
  }
  o.IsNull = false
  return json.Unmarshal(data, &o.Value)
}
```

Update `backend/internal/domain/services/docsystem/document.go`:

```go
// OptionalAIVersion is transport-agnostic PATCH semantics for ai_version:
// - Present=false => no change
// - Present=true + Value=nil => clear
// - Present=true + Value=&"" or &"text" => set ("" is valid)
type OptionalAIVersion struct {
  Present bool
  Value   *string
}

type UpdateDocumentRequest struct {
  ProjectID  string                 `json:"project_id"`
  Name       *string                `json:"name,omitempty"`
  FolderPath *string                `json:"folder_path,omitempty"`
  FolderID   *string                `json:"folder_id,omitempty"`
  Content    *string                `json:"content,omitempty"`
  AIVersion  OptionalAIVersion      `json:"-"`
}
```

Update `backend/internal/handler/document.go` to parse a handler-level PATCH DTO and map into the service request:

```go
type updateDocumentPatchRequest struct {
  ProjectID  string                  `json:"project_id"`
  Name       *string                 `json:"name,omitempty"`
  FolderPath *string                 `json:"folder_path,omitempty"`
  FolderID   *string                 `json:"folder_id,omitempty"`
  Content    *string                 `json:"content,omitempty"`
  AIVersion  httputil.OptionalString `json:"ai_version"`
}

// In handler UpdateDocument:
var dto updateDocumentPatchRequest
if err := httputil.ParseJSON(w, r, &dto); err != nil { ... }

req := docsysSvc.UpdateDocumentRequest{
  ProjectID:  dto.ProjectID,
  Name:       dto.Name,
  FolderPath: dto.FolderPath,
  FolderID:   dto.FolderID,
  Content:    dto.Content,
}

if dto.AIVersion.Present {
  if dto.AIVersion.IsNull {
    req.AIVersion = docsysSvc.OptionalAIVersion{Present: true, Value: nil}
  } else {
    v := dto.AIVersion.Value
    req.AIVersion = docsysSvc.OptionalAIVersion{Present: true, Value: &v}
  }
}
```

Update `backend/internal/service/docsystem/document.go` in `UpdateDocument(...)`:

```go
if req.AIVersion.Present {
  if req.AIVersion.Value == nil {
    doc.AIVersion = nil
  } else {
    doc.AIVersion = req.AIVersion.Value // includes ""
  }
}
```

Update `backend/internal/repository/postgres/docsystem/document.go` in `Update(...)` to persist `ai_version` in the same SQL statement (add `ai_version = $X` and include `doc.AIVersion` in args).

Proceed to Step 4.1 for frontend API client changes.

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
   */
  update: async (
    id: string,
    updates: { content?: string; aiVersion?: string | null },
    options?: { signal?: AbortSignal }
  ): Promise<Document> => {
    const body: Record<string, unknown> = {}
    if (updates.content !== undefined) body.content = updates.content
    if (updates.aiVersion !== undefined) body.ai_version = updates.aiVersion

    const data = await fetchAPI<DocumentDto>(`/api/documents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
      signal: options?.signal,
    })
    return fromDocumentDto(data)
  },
}
```

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
  options?: { signal?: AbortSignal }
): Promise<SaveMergedResult> {
  // Parse merged document to extract content and aiVersion
  const parsed = parseMergedDocument(merged)

  // Build update payload
  const updates = {
    content: parsed.content,
    // Still has markers → keep aiVersion; no markers → clear (AI session complete)
    aiVersion: parsed.hasChanges ? parsed.aiVersion : null,
  } satisfies { content: string; aiVersion: string | null }

  // Optimistic update to IndexedDB
  // NOTE: Use null (not undefined) to clear aiVersion - Dexie ignores undefined fields
  const now = new Date()
  await db.documents.update(documentId, {
    content: parsed.content,
    aiVersion: parsed.hasChanges ? parsed.aiVersion : null,  // null clears, undefined skips
    updatedAt: now,
  })

  // Save to server (single request)
  const document = await api.documents.update(documentId, updates, options)

  return {
    document,
    hasChanges: parsed.hasChanges,
  }
}
```

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
  cbs?: {
    onServerSaved?: (result: SaveMergedResult) => void
    onRetryScheduled?: () => void
    onError?: (error: Error) => void
  }
): Promise<void> {
  // Cancel any pending retries for this document
  cancelDocumentPatchRetry(documentId)

  try {
    const result = await saveMergedDocument(documentId, merged)
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
- [ ] Empty string `""` content/aiVersion handled correctly (not treated as falsy)

## Files Modified/Created

| File | Action |
|------|--------|
| `backend/internal/httputil/optional_string.go` | Created |
| `backend/internal/domain/services/docsystem/document.go` | Modified |
| `backend/internal/service/docsystem/document.go` | Modified |
| `backend/internal/repository/postgres/docsystem/document.go` | Modified |
| `frontend/src/core/lib/api.ts` | Modified |
| `frontend/src/features/documents/utils/saveMergedDocument.ts` | Created |
| `frontend/src/core/services/documentSyncService.ts` | Modified |
| `frontend/src/core/stores/useEditorStore.ts` | Modified |

## Next Step

→ Continue to `05-ui-components.md` to build the navigator pill and hunk action buttons.
