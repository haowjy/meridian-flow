/**
 * Shared Reference Types
 *
 * Types used by wiki-links, markdown links, and any other internal link systems.
 * Single source of truth for reference resolution and classification.
 */

// =============================================================================
// LINK CLASSIFICATION
// =============================================================================

/**
 * Classification of a link target:
 * - internal: Resolved path to a document/folder in the tree
 * - external: Protocol URLs OR unresolved paths (treated as external URLs)
 * - anchor: Fragment-only links within current document (e.g., "#heading")
 * - unsupported: Patterns we don't handle (absolute paths, query strings)
 */
export type LinkTargetType = "internal" | "external" | "anchor" | "unsupported";

/**
 * Result of classifying a link target URL/path.
 * Discriminated union based on type.
 */
export type LinkClassification =
  | { type: "external"; normalizedPath: string }
  | { type: "anchor"; normalizedPath: ""; anchor: string }
  | { type: "unsupported"; normalizedPath: string }
  | {
      type: "internal";
      normalizedPath: string;
      anchor?: string;
      resolved: ResolvedRef;
    };

// =============================================================================
// RESOLVED REFERENCE
// =============================================================================

/**
 * A resolved reference pointing to an existing document or folder.
 */
export type ResolvedRef =
  | { type: "document"; id: string; name: string; path: string }
  | { type: "folder"; id: string; name: string; path: string };
