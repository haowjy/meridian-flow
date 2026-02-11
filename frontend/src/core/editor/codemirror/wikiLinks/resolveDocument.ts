/**
 * Wiki-Link Resolution (Backward Compatibility)
 *
 * This module re-exports from the shared core/references domain.
 * Existing imports from this file continue to work unchanged.
 *
 * For new code, prefer importing directly from "@/core/references".
 */

// Re-export types and functions from shared domain
export type { ResolvedRef } from "@/core/references";
export {
  resolveReference,
  resolveDocumentPathById,
  resolvePathById,
} from "@/core/references";
