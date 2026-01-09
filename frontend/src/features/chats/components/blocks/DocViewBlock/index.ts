/**
 * DocViewBlock - Custom UI for doc_view tool interactions
 *
 * Usage:
 * 1. This component is automatically used via the tool registry
 * 2. Register in toolRegistry.ts (already done)
 *
 * @see toolRegistry.ts for the registration pattern
 */

export { DocViewBlock } from './DocViewBlock'
export type {
  DocViewInput,
  DocViewResult,
  DocViewDocumentResult,
  DocViewFolderResult,
  DocViewFolderDocument,
  DocViewFolderChild,
} from './types'
