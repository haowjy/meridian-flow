/**
 * useDocumentPolling - Poll for document ai_version changes from background AI processes.
 *
 * Two-phase polling for efficiency:
 * 1. Poll lightweight /ai-status endpoint every 5s (~100 bytes)
 * 2. Only fetch full document when change is detected
 *
 * Polls always when document is open (not just when AI session is active),
 * allowing detection of new AI edits the user hasn't seen yet.
 *
 * Why polling (not SSE):
 * - No backend changes required
 * - Simpler to implement and debug
 * - Sufficient for v1 where background AI updates are infrequent
 * - Easy to swap for SSE later (same callback interface)
 */

import { api, type AIStatusResponse } from '@/core/lib/api'
import { useLatestRef, useResourcePolling } from '@/core/hooks'
import type { Document } from '../types/document'

/**
 * Options for document polling.
 */
export interface UseDocumentPollingOptions {
  /** Document ID to poll. Polling disabled if undefined. */
  documentId: string | undefined
  /** Current aiVersionRev (CAS token). Used to detect changes. */
  currentAIVersionRev: number | null
  /** Whether user has pending edits. Polling paused when true. */
  hasUserEdit: boolean
  /** Polling interval in ms. Default: 5000 */
  intervalMs?: number
}

/**
 * Handlers for document polling events.
 */
export interface UseDocumentPollingHandlers {
  /** Called when server has newer aiVersion. Receives the updated document. */
  onAIVersionChanged: (document: Document) => void
  /** Called on fetch errors (optional). */
  onError?: (error: Error) => void
}

/**
 * Poll for document ai_version changes from background AI processes.
 *
 * Polls when:
 * - documentId is defined
 * - hasUserEdit is false (editor is not dirty)
 *
 * Note: Removed hasAIVersion condition - now polls always when document is open.
 * This allows detecting new AI edits the user hasn't seen yet.
 *
 * @example
 * ```tsx
 * useDocumentPolling(
 *   {
 *     documentId: activeDocument?.id,
 *     currentAIVersionRev: aiVersionBaseRevRef.current,
 *     hasUserEdit,
 *     intervalMs: 5000,
 *   },
 *   {
 *     onAIVersionChanged: (doc) => {
 *       if (hasUserEdit) {
 *         setPendingServerSnapshot(doc)
 *       } else {
 *         hydrateDocument(doc)
 *       }
 *     },
 *   }
 * )
 * ```
 */
export function useDocumentPolling(
  options: UseDocumentPollingOptions,
  handlers: UseDocumentPollingHandlers
): void {
  const {
    documentId,
    currentAIVersionRev,
    hasUserEdit,
    intervalMs = 5000,
  } = options

  // Use latest refs for values that change frequently but shouldn't restart interval
  const currentRevRef = useLatestRef(currentAIVersionRev)
  const handlersRef = useLatestRef(handlers)

  useResourcePolling<AIStatusResponse>({
    // Always poll when document is open (removed hasAIVersion condition)
    // This allows detecting new AI edits the user hasn't seen yet
    enabled: !!documentId && !hasUserEdit,
    intervalMs,

    // Phase 1: Lightweight status check (~100 bytes vs ~50KB full document)
    fetch: (signal) => api.documents.getAIStatus(documentId!, { signal }),

    // Determine if AI version changed
    shouldUpdate: (status) => {
      const newRev = status.aiVersionRev
      const currentRev = currentRevRef.current

      // Case 1: AI version appeared for first time (was null, now has value)
      if (currentRev === null && newRev !== null) return true

      // Case 2: Rev incremented (existing AI version updated)
      if (newRev !== null && currentRev !== null && newRev !== currentRev) return true

      return false
    },

    // Phase 2: On change, fetch full document then call handler
    onUpdate: async () => {
      try {
        const doc = await api.documents.get(documentId!)

        // Call handler (will stash or hydrate based on hasUserEdit in caller)
        // Double-check hasn't started editing during the fetch
        handlersRef.current.onAIVersionChanged(doc)
      } catch (err) {
        handlersRef.current.onError?.(err as Error)
      }
    },

    onError: handlers.onError,
  })
}
