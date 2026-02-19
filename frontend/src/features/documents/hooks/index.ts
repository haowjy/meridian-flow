/**
 * Document feature hooks barrel export.
 */

// Editor lifecycle hooks (composable)
export {
  useDocumentContent,
  type DocumentSyncContext,
  type UseDocumentContentResult,
} from "./useDocumentContent";
export { useDocumentSync } from "./useDocumentSync";
export { useDocumentCollab } from "./useDocumentCollab";
export { useProjectCollab } from "./useProjectCollab";

// UI utility hooks
export { useThumbFollow } from "./useThumbFollow";
