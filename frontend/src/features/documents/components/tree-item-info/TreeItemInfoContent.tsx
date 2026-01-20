import { TreeItemInfoHeader } from './TreeItemInfoHeader'
import { TreeItemInfoMeta } from './TreeItemInfoMeta'
import type { Folder } from '@/features/folders/types/folder'
import type { Document } from '@/features/documents/types/document'
import { FileText, Folder as FolderIcon } from 'lucide-react'

// TODO: Future enhancements for TreeItemInfoContent:
// - TreeItemInfoSummary: AI-generated summary (read-only display)
// - TreeItemInfoTags: Tag display (read-only chips)
// - Edit actions: Single "Edit" button → popup with all editable fields
//   (tags, summary, etc.) rather than individual edit menu items

interface FolderContentProps {
  type: 'folder'
  item: Folder
  documentCount?: number
  folderCount?: number
}

interface DocumentContentProps {
  type: 'document'
  item: Document
}

type TreeItemInfoContentProps = (FolderContentProps | DocumentContentProps) & {
  /**
   * - `hover`: compact, preview-like (no filename; avoids covering list scanning).
   * - `dialog`: full details, including name header.
   */
  variant?: 'hover' | 'dialog'
}

/**
 * Shared content component used by both HoverCard and Dialog.
 * Composed of sections for extensibility.
 */
export function TreeItemInfoContent(props: TreeItemInfoContentProps) {
  const variant = props.variant ?? 'hover'

  if (variant === 'hover') {
    const Icon = props.type === 'folder' ? FolderIcon : FileText
    const label = props.type === 'folder' ? 'Folder' : 'Document'

    return (
      <div className="space-y-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className="size-3.5 flex-shrink-0" />
          <span>{label}</span>
        </div>
        {props.type === 'folder' ? (
          <TreeItemInfoMeta
            type="folder"
            item={props.item}
            documentCount={props.documentCount}
            folderCount={props.folderCount}
          />
        ) : (
          <TreeItemInfoMeta type="document" item={props.item} />
        )}
      </div>
    )
  }

  if (props.type === 'folder') {
    return (
      <div className="space-y-3">
        <TreeItemInfoHeader name={props.item.name} type="folder" />
        <TreeItemInfoMeta
          type="folder"
          item={props.item}
          documentCount={props.documentCount}
          folderCount={props.folderCount}
        />
        {/* Future: <TreeItemInfoSummary /> */}
        {/* Future: <TreeItemInfoTags /> */}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <TreeItemInfoHeader name={props.item.filename} type="document" />
      <TreeItemInfoMeta type="document" item={props.item} />
      {/* Future: <TreeItemInfoSummary /> */}
      {/* Future: <TreeItemInfoTags /> */}
    </div>
  )
}
