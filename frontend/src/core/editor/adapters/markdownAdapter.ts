/**
 * Markdown Content Adapter
 *
 * Wraps the existing PUA marker system for markdown documents.
 * This adapter transforms between storage (content + aiVersion) and
 * editor format (merged document with PUA markers).
 *
 * Backwards compatible - reuses all existing mergedDocument logic.
 */

import {
  buildMergedDocument,
  parseMergedDocument,
  hasAnyMarker,
} from "@/core/lib/mergedDocument";
import type { TypedContentAdapter } from "./types";

/**
 * Markdown adapter using PUA marker system.
 *
 * Storage format: { content: string, aiVersion: string | null }
 * Editor format: string (merged document with PUA markers)
 *
 * Key insight: This is a WRAPPER around existing logic, not a rewrite.
 */
export const markdownAdapter: TypedContentAdapter<"markdown"> = {
  editorType: "markdown",

  toEditor(content: string, aiVersion?: string | null): string {
    // If no AI version, return content as-is
    if (!aiVersion) {
      return content;
    }

    // Build merged document with PUA markers (existing logic)
    return buildMergedDocument(content, aiVersion);
  },

  toStorage(mergedDoc: string): { content: string; aiVersion: string | null } {
    // Parse merged document back to content + aiVersion (existing logic)
    const parsed = parseMergedDocument(mergedDoc);
    return {
      content: parsed.content,
      aiVersion: parsed.aiVersion,
    };
  },

  hasAISuggestions(mergedDoc: string): boolean {
    // Check if any PUA marker exists (existing logic)
    return hasAnyMarker(mergedDoc);
  },

  capabilities: {
    supportsAIDiff: true, // ✅ Inline diff with PUA markers
    supportsVersioning: true, // ✅ Separate content + aiVersion
    contentFormat: "string",
    editable: true,
  },
};
