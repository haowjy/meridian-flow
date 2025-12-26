# Phase 4a: Conflict Error Handling

## Goal

Define utilities for handling 409 Conflict responses when `ai_version_rev` mismatches.

## What You're Building

1. Error type detection: `isConflictError(error)`
2. Document extraction: `extractDocumentFromConflict(error)`
3. Type definitions for conflict response

These utilities are used by `documentSyncService` when a save fails due to a stale `ai_version_base_rev`.

## Steps

### Step 4a.1: Define conflict response types

Create `frontend/src/types/errors.ts` (or add to existing types file):

```typescript
/**
 * 409 Conflict response body from PATCH /api/documents/{id}
 * when ai_version_base_rev doesn't match current ai_version_rev.
 */
export interface AIVersionConflictResponse {
  error: 'ai_version_conflict'
  message: string
  current_ai_version_rev: number
  document: {
    id: string
    content: string
    ai_version: string | null
    ai_version_rev: number
    updated_at: string
  }
}

/**
 * Extended Error type with conflict body attached.
 * Created by API client when 409 is received.
 */
export interface ConflictError extends Error {
  status: 409
  error: 'ai_version_conflict'
  message: string
  current_ai_version_rev: number
  document: AIVersionConflictResponse['document']
}
```

---

### Step 4a.2: Create error utilities

Create `frontend/src/core/lib/errorUtils.ts`:

```typescript
import type { AIVersionConflictResponse, ConflictError } from '@/types/errors'
import type { Document } from '@/types'

/**
 * Check if an error is a 409 Conflict from ai_version_rev mismatch.
 */
export function isConflictError(error: unknown): error is ConflictError {
  if (!error || typeof error !== 'object') return false

  // Check for our enriched error format
  if ('status' in error && (error as { status: number }).status === 409) {
    if ('error' in error && (error as { error: string }).error === 'ai_version_conflict') {
      return true
    }
  }

  return false
}

/**
 * Check if an error is a network error (fetch failed, offline, etc.)
 */
export function isNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false

  // TypeError is thrown by fetch when network is unavailable
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return true
  }

  // Check for our custom network error marker
  if ('isNetworkError' in error && (error as { isNetworkError: boolean }).isNetworkError) {
    return true
  }

  return false
}

/**
 * Check if an error is an abort error (request cancelled).
 */
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false

  if (error instanceof DOMException && error.name === 'AbortError') {
    return true
  }

  return false
}

/**
 * Extract the current document from a 409 Conflict response.
 * Returns undefined if the error doesn't contain a document.
 */
export function extractDocumentFromConflict(error: unknown): Document | undefined {
  if (!isConflictError(error)) return undefined

  const conflictDoc = error.document
  if (!conflictDoc) return undefined

  return mapConflictDocumentToDocument(conflictDoc)
}

/**
 * Map the conflict response document to our Document type.
 *
 * Note: The conflict response may not include all document fields.
 * Fields not included in the response are set to reasonable defaults.
 */
function mapConflictDocumentToDocument(
  conflictDoc: AIVersionConflictResponse['document']
): Document {
  return {
    id: conflictDoc.id,
    content: conflictDoc.content,
    aiVersion: conflictDoc.ai_version,
    aiVersionRev: conflictDoc.ai_version_rev,
    updatedAt: new Date(conflictDoc.updated_at),
    // Fields not in conflict response - use defaults or fetch full doc if needed
    name: '',
    projectId: '',
    folderId: null,
    createdAt: new Date(),
  }
}
```

---

### Step 4a.3: Update API client to preserve error body

Update `frontend/src/core/lib/api.ts`:

```typescript
/**
 * Fetch wrapper that handles common error cases.
 */
async function fetchAPI<T>(url: string, options?: RequestInit): Promise<T> {
  let response: Response

  try {
    response = await fetch(url, options)
  } catch (error) {
    // Network error (offline, DNS failure, etc.)
    if (error instanceof TypeError) {
      const networkError = new Error('Network error: Unable to reach server')
      Object.assign(networkError, { isNetworkError: true })
      throw networkError
    }
    throw error
  }

  if (!response.ok) {
    // For 409, parse and attach the full body to the error
    // so downstream handlers can extract the document
    if (response.status === 409) {
      const body = await response.json() as AIVersionConflictResponse
      const error = new Error(body.message || 'Conflict') as ConflictError
      Object.assign(error, body, { status: 409 })
      throw error
    }

    // For other errors, try to parse JSON body
    let errorMessage = `HTTP ${response.status}`
    try {
      const body = await response.json()
      errorMessage = body.message || body.error || errorMessage
    } catch {
      // Body not JSON, use status text
      errorMessage = response.statusText || errorMessage
    }

    const error = new Error(errorMessage)
    Object.assign(error, { status: response.status })
    throw error
  }

  return response.json()
}
```

---

### Step 4a.4: Update documentSyncService to use utilities

Update `frontend/src/core/services/documentSyncService.ts`:

```typescript
import {
  isConflictError,
  isNetworkError,
  isAbortError,
  extractDocumentFromConflict
} from '@/core/lib/errorUtils'

// In saveMerged method:
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
      cbs?.onRetryScheduled?.()
      return
    }

    if (isConflictError(error)) {
      // Extract the latest document from the 409 response
      // This allows the UI to show "Refresh" with the new state
      const serverDocument = extractDocumentFromConflict(error)
      cbs?.onAIVersionConflict?.(serverDocument)
      return
    }

    cbs?.onError?.(error as Error)
    throw error
  }
}
```

---

## Backend Contract (Reference)

The backend must return this structure for 409 Conflict:

```json
{
  "error": "ai_version_conflict",
  "message": "Document ai_version was modified since last fetch",
  "current_ai_version_rev": 5,
  "document": {
    "id": "...",
    "content": "...",
    "ai_version": "...",
    "ai_version_rev": 5,
    "updated_at": "2024-01-15T12:00:00Z"
  }
}
```

See `00-backend-contract.md` for backend implementation details.

---

## Verification Checklist

- [ ] `isConflictError()` returns true for 409 conflict responses
- [ ] `isConflictError()` returns false for other 4xx/5xx errors
- [ ] `extractDocumentFromConflict()` returns document from error body
- [ ] `extractDocumentFromConflict()` returns undefined for non-conflict errors
- [ ] API client attaches full body to 409 errors
- [ ] `documentSyncService` correctly handles 409 and calls `onAIVersionConflict`

## Files Created

| File | Purpose |
|------|---------|
| `frontend/src/types/errors.ts` | Conflict response types |
| `frontend/src/core/lib/errorUtils.ts` | Error utilities |

## Files Modified

| File | Change |
|------|--------|
| `frontend/src/core/lib/api.ts` | Preserve error body for 409 |
| `frontend/src/core/services/documentSyncService.ts` | Use error utilities |

## Next Step

→ Continue to `05-ui-components.md` for navigator and action buttons.
