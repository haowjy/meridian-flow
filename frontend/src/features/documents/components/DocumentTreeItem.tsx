import { FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TreeItemWithContextMenu } from '@/shared/components/TreeItemWithContextMenu'
import { createDocumentMenuItems } from '../utils/menuBuilders'
import type { Document } from '../types/document'

interface DocumentTreeItemProps {
  document: Document
  isActive: boolean
  onClick: () => void
  onDelete?: () => void
  onRename?: () => void
  onAddAsReference?: () => void
}

/**
 * Clickable document leaf node in tree.
 * Highlights when active, shows document icon.
 * Right-click for context menu with actions.
 */
export function DocumentTreeItem({
  document,
  isActive,
  onClick,
  onDelete,
  onRename,
  onAddAsReference,
}: DocumentTreeItemProps) {
  const menuItems = createDocumentMenuItems({
    onRename,
    onDelete,
    onAddAsReference,
  })

  return (
    <TreeItemWithContextMenu menuItems={menuItems}>
      <button
        onClick={onClick}
        className={cn(
          'flex w-full items-center gap-2 rounded-sm px-2.5 py-1 text-left text-xs md:text-sm transition-colors',
          'hover:bg-hover',
          isActive && 'bg-muted font-medium border-l-2 border-accent'
        )}
        aria-label={`Open document: ${document.name}`}
        aria-current={isActive ? 'page' : undefined}
      >
        <FileText className="size-4 flex-shrink-0" />
        <span className="truncate">{document.name}</span>
      </button>
    </TreeItemWithContextMenu>
  )
}
