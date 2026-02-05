/**
 * Shared components for tool blocks
 *
 * These components are designed to be reused across multiple tool blocks
 * following SOLID principles.
 */

export { FolderTreeView } from './FolderTreeView'
export type { FolderTreeViewProps } from './FolderTreeView'

export { CollapsibleToolBlock } from './CollapsibleToolBlock'
export type { CollapsibleToolBlockProps } from './CollapsibleToolBlock'

export { ToolStatusBadge } from './ToolStatusBadge'
export type { ToolStatus, ToolStatusBadgeProps } from './ToolStatusBadge'

export { useToolStreamingState } from './useToolStreamingState'

export { CodeMirrorPreview } from './CodeMirrorPreview'
export type { CodeMirrorPreviewProps } from './CodeMirrorPreview'
