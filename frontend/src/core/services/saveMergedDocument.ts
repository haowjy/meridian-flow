/**
 * Save helper for merged documents with PUA markers.
 *
 * Parses the merged document to extract content and aiVersion,
 * then saves both in a single API call with CAS protection.
 */

import { parseMergedDocument } from '@/core/lib/mergedDocument'
import { api } from '@/core/lib/api'
import { db } from '@/core/lib/db'
import type { Document } from '@/features/documents/types/document'

export interface SaveMergedResult {
  /** The saved document from server */
  document: Document
  /** Whether the document still has AI changes (markers remain) */
  hasChanges: boolean
}

export interface SaveMergedOptions {
  /** Last ai_version_rev the client hydrated from (required for CAS) */
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
 * Save decision logic:
 * - hasChanges (markers exist) → PATCH ai_version as string + ai_version_base_rev
 * - no markers + server open → PATCH ai_version: null + ai_version_base_rev (close session)
 * - no markers + server closed → omit ai_version entirely (content-only save)
 *
 * @param documentId - The document ID
 * @param merged - The merged document with PUA markers
 * @param options - Save options including CAS token
 * @returns Save result with server document and hasChanges flag
 */
export async function saveMergedDocument(
  documentId: string,
  merged: string,
  options: SaveMergedOptions
): Promise<SaveMergedResult> {
  // Parse merged document to extract content and aiVersion
  const parsed = parseMergedDocument(merged)

  // Build update payload based on:
  // - hasChanges (markers exist) → PATCH ai_version as string
  // - no markers + server open → PATCH ai_version: null once to close
  // - no markers + server closed → omit ai_version entirely
  const updates: {
    content: string
    aiVersion?: string | null
    aiVersionBaseRev?: number
  } = { content: parsed.content }

  if (parsed.hasChanges) {
    updates.aiVersion = parsed.aiVersion
    updates.aiVersionBaseRev = options.aiVersionBaseRev
  } else if (options.serverHasAIVersion) {
    // Close AI session: markers are gone but server still has ai_version
    updates.aiVersion = null
    updates.aiVersionBaseRev = options.aiVersionBaseRev
  }
  // else: no markers + server closed → omit ai_version entirely

  // Optimistic IndexedDB update
  // NOTE: Use null (not undefined) to clear aiVersion - Dexie ignores undefined fields
  const now = new Date()
  await db.documents.update(documentId, {
    content: parsed.content,
    // Mirror server intent:
    // - has markers → keep aiVersion in local cache
    // - no markers → clear in local cache
    aiVersion: parsed.hasChanges ? parsed.aiVersion : null,
    updatedAt: now,
  })

  // API call (single request for both content and aiVersion)
  const document = await api.documents.update(documentId, updates, {
    signal: options.signal,
  })

  return {
    document,
    hasChanges: parsed.hasChanges,
  }
}
