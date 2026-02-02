/**
 * Plaintext Content Adapter
 *
 * Plaintext (.txt) is text-based like markdown, so it can reuse
 * the PUA marker system for AI integration.
 *
 * Storage format: { content: string, aiVersion: string | null }
 * Editor format: string (merged document with PUA markers)
 */

import {
  buildMergedDocument,
  parseMergedDocument,
  hasAnyMarker,
} from '@/core/lib/mergedDocument'
import type { TypedContentAdapter } from './types'

/**
 * Plaintext adapter using PUA marker system (same as markdown).
 *
 * Key insight: Plaintext is just text, so it can reuse all the markdown
 * AI integration logic without modification.
 */
export const plaintextAdapter: TypedContentAdapter<'plaintext'> = {
  editorType: 'plaintext',

  toEditor(content: string, aiVersion?: string | null): string {
    // Identical to markdown adapter
    if (!aiVersion) {
      return content
    }
    return buildMergedDocument(content, aiVersion)
  },

  toStorage(mergedDoc: string): { content: string; aiVersion: string | null } {
    // Identical to markdown adapter
    const parsed = parseMergedDocument(mergedDoc)
    return {
      content: parsed.content,
      aiVersion: parsed.aiVersion,
    }
  },

  hasAISuggestions(mergedDoc: string): boolean {
    // Identical to markdown adapter
    return hasAnyMarker(mergedDoc)
  },

  capabilities: {
    supportsAIDiff: true, // ✅ Same inline diff as markdown (text-based)
    supportsVersioning: true, // ✅ Separate content + aiVersion
    contentFormat: 'string',
    editable: true,
  },
}
