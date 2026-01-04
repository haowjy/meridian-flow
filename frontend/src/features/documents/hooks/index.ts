/**
 * Document feature hooks barrel export.
 */

// Editor lifecycle hooks (composable)
export { useDocumentContent, type DocumentSyncContext, type UseDocumentContentResult } from './useDocumentContent'
export { useDocumentSync } from './useDocumentSync'

// Visualization hooks
export { useDiffView, type UseDiffViewOptions, type UseDiffViewResult } from './useDiffView'

// Polling hooks
export { useDocumentPolling, type UseDocumentPollingOptions, type UseDocumentPollingHandlers } from './useDocumentPolling'

// UI utility hooks
export { useThumbFollow } from './useThumbFollow'
