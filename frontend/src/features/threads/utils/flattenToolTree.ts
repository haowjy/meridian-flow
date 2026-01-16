/**
 * Re-export flattenToolTree from core layer for backwards compatibility.
 *
 * The utility was moved to @/core/lib/flattenToolTree to avoid DIP violation
 * (core importing from features).
 */

export {
  flattenToolTree,
  type FlattenResult,
  type PartialDocument,
  type PartialFolder,
} from '@/core/lib/flattenToolTree'
