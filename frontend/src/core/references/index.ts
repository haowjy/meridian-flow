/**
 * Core References Module
 *
 * Shared domain for internal link resolution and classification.
 * Used by wiki-links, markdown links, and other reference systems.
 */

// Types
export type {
  LinkTargetType,
  LinkClassification,
  ResolvedRef,
} from "./types";

// Classification
export { classifyLinkTarget, isExternalLink } from "./classifyLinkTarget";

// Path utilities
export { buildFolderPath } from "./pathing";

// Resolution
export {
  type ResolverDocument,
  type ResolverFolder,
  type ResolverTreeSnapshot,
  resolveReferenceFromTree,
  resolveDocumentPathByIdFromTree,
  resolvePathByIdFromTree,
  resolveReference,
  resolveDocumentPathById,
  resolvePathById,
} from "./resolve";
