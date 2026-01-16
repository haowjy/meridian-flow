import { formatWordCount, formatRelativeTime, formatFileSize } from '@/core/lib/formatters'

/**
 * Follows SRP: only handles metadata display logic.
 * Follows OCP: can be extended with new metadata types without modifying tree items.
 * Uses discriminated union to prevent invalid prop combinations.
 */

interface DocumentMetadataProps {
  type: 'document'
  wordCount?: number
  updatedAt?: Date
  fileSize?: number
}

interface FolderMetadataProps {
  type: 'folder'
  childCount: number
  documentCount?: number
  folderCount?: number
}

type TreeItemMetadataProps = DocumentMetadataProps | FolderMetadataProps

/**
 * Display metadata for tree items (documents or folders).
 * Appears on hover to keep the UI clean.
 *
 * @example
 * // For document
 * <TreeItemMetadata
 *   type="document"
 *   wordCount={1234}
 *   updatedAt={new Date()}
 * />
 *
 * // For folder
 * <TreeItemMetadata
 *   type="folder"
 *   childCount={5}
 *   documentCount={3}
 *   folderCount={2}
 * />
 */
export function TreeItemMetadata(props: TreeItemMetadataProps) {
  if (props.type === 'document') {
    // Only show metadata if at least one field is present
    const hasMetadata = props.wordCount || props.updatedAt || props.fileSize

    if (!hasMetadata) return null

    return (
      <div className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-2">
        {props.wordCount !== undefined && props.wordCount > 0 && (
          <span>{formatWordCount(props.wordCount)}</span>
        )}
        {props.updatedAt && <span>{formatRelativeTime(props.updatedAt)}</span>}
        {props.fileSize && <span>{formatFileSize(props.fileSize)}</span>}
      </div>
    )
  }

  // Folder metadata
  if (props.childCount === 0) return null

  return (
    <div className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
      {props.documentCount !== undefined && props.folderCount !== undefined
        ? `${props.documentCount} docs, ${props.folderCount} folders`
        : `${props.childCount} items`}
    </div>
  )
}
