import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/shared/components/ui/hover-card'
import { TreeItemInfoContent } from './TreeItemInfoContent'
import type { Folder } from '@/features/folders/types/folder'
import type { Document } from '@/features/documents/types/document'
import type { ReactElement } from 'react'

interface FolderHoverCardProps {
  children: ReactElement
  item: Folder
  type: 'folder'
  documentCount?: number
  folderCount?: number
}

interface DocumentHoverCardProps {
  children: ReactElement
  item: Document
  type: 'document'
}

type TreeItemInfoHoverCardProps = FolderHoverCardProps | DocumentHoverCardProps

/**
 * HoverCard wrapper for hover-triggered info display (desktop).
 * Shows TreeItemInfoContent on hover with a slight delay.
 */
export function TreeItemInfoHoverCard(props: TreeItemInfoHoverCardProps) {
  const { children, type } = props

  return (
    <HoverCard openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        side="left"
        align="start"
        sideOffset={12}
        className={[
          'relative w-64 p-3',
          // CSS arrow (border + fill) to avoid seam between card border and SVG arrow.
          // Points toward the trigger when the content is rendered on the left.
          "before:content-[''] before:absolute before:top-2 before:right-[-10px] before:border-t-[7px] before:border-b-[7px] before:border-l-[10px] before:border-t-transparent before:border-b-transparent before:border-l-border",
          "after:content-[''] after:absolute after:top-2 after:right-[-9px] after:border-t-[6px] after:border-b-[6px] after:border-l-[9px] after:border-t-transparent after:border-b-transparent after:border-l-popover",
        ].join(' ')}
      >
        {type === 'folder' ? (
          <TreeItemInfoContent
            variant="hover"
            type="folder"
            item={props.item}
            documentCount={props.documentCount}
            folderCount={props.folderCount}
          />
        ) : (
          <TreeItemInfoContent variant="hover" type="document" item={props.item} />
        )}
      </HoverCardContent>
    </HoverCard>
  )
}
