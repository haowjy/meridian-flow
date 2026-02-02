import { useState, memo } from 'react'
import { FileText, MoreHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/shared/components/ui/button'
import { TreeItemMenuItems } from '@/shared/components/TreeItemMenuItems'
import { TreeItemWithContextMenu } from '@/shared/components/TreeItemWithContextMenu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import { createDocumentMenuItems } from '../utils/menuBuilders'
import { InlineNameEditor } from './InlineNameEditor'
import { TreeItemInfoHoverCard, HoverCardTrigger } from './tree-item-info/TreeItemInfoHoverCard'
import { useTreeSelection } from '../hooks/useTreeSelection'
import type { Document } from '../types/document'

interface DocumentTreeItemProps {
  document: Document
  isActive: boolean
  // Callbacks accept documentId for stable references (no inline arrows in parent)
  onClick: (documentId: string) => void
  onDelete?: (documentId: string) => void
  onRename?: (documentId: string) => void
  onShowDetails?: (documentId: string, document: Document) => void
  // Inline editing props
  isEditing?: boolean
  onSubmitName?: (documentId: string, name: string) => void
  onCancelEdit?: () => void
  existingNames?: string[]
  /**
   * Controls how the inline editor behaves.
   * - 'rename' (default): existing document rename.
   * - 'create': new, temporary document being created.
   */
  editorMode?: 'rename' | 'create'
}

/**
 * Clickable document leaf node in tree.
 * Highlights when active, shows document icon.
 * Right-click for context menu with actions.
 *
 * Memoized to prevent re-renders when parent tree re-renders.
 * Callbacks accept document.id as first param for stable references.
 */
export const DocumentTreeItem = memo(function DocumentTreeItem({
  document,
  isActive,
  onClick,
  onDelete,
  onRename,
  onShowDetails,
  isEditing,
  onSubmitName,
  onCancelEdit,
  existingNames = [],
  editorMode = 'rename',
}: DocumentTreeItemProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [contextMenuOpen, setContextMenuOpen] = useState(false)
  const { toggleSelection, clearSelection } = useTreeSelection()

  // Wrap callbacks to pass document.id - these are only created when menu opens
  const menuItems = createDocumentMenuItems({
    onDetails: onShowDetails ? () => onShowDetails(document.id, document) : undefined,
    onRename: onRename ? () => onRename(document.id) : undefined,
    onDelete: onDelete ? () => onDelete(document.id) : undefined,
  })

  const hasMenuItems = menuItems.length > 0

  // When editing, render inline editor without context menu
  if (isEditing && onSubmitName && onCancelEdit) {
    return (
      <div
        className={cn(
          'group flex w-full items-center gap-2 rounded-sm px-2.5 py-2 md:py-1 text-left text-sm',
          isActive && 'bg-sidebar-accent/50'
        )}
      >
        <FileText className="size-5 md:size-4 flex-shrink-0" />
        <InlineNameEditor
          initialValue={document.name}
          existingNames={existingNames}
          onSubmit={(name) => onSubmitName(document.id, name)}
          onCancel={onCancelEdit}
          mode={editorMode}
          extension={document.extension}
          type="document"  // NEW: enables slash/length validation for documents
        />
      </div>
    )
  }

  return (
    <TreeItemInfoHoverCard type="document" item={document}>
      <TreeItemWithContextMenu
        menuItems={menuItems}
        onOpenChange={(open) => {
          setContextMenuOpen(open)
          if (open) setDropdownOpen(false)
        }}
        triggerWrapper={(children) => <HoverCardTrigger asChild>{children}</HoverCardTrigger>}
      >
        <div
          className={cn(
            'group flex w-full items-center rounded-sm text-left text-sm transition-colors',
            'hover:bg-hover',
            isActive && 'bg-sidebar-accent/50 font-medium'
          )}
        >
          <button
            type="button"
            onClick={(e) => {
              // Modifier key pressed → toggle selection
              if (e.metaKey || e.ctrlKey) {
                e.preventDefault()
                toggleSelection(document.id)
                return
              }

              // No modifier → clear selection and navigate
              clearSelection()
              onClick(document.id)
            }}
            className={cn(
              'flex flex-1 min-w-0 items-center gap-2 px-2.5 py-2 md:py-1',
              'cursor-pointer appearance-none bg-transparent border-none m-0 font-inherit text-inherit text-left'
            )}
            aria-label={`Open document: ${document.filename}`}
            aria-current={isActive ? 'page' : undefined}
          >
            <FileText className="size-5 md:size-4 flex-shrink-0" />
            <span className="truncate">{document.filename}</span>
          </button>

          {/* "..." button - visible on hover or always on mobile */}
          {hasMenuItems && (
            <DropdownMenu
              open={dropdownOpen}
              onOpenChange={(open) => {
                setDropdownOpen(open)
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={contextMenuOpen}
                  className={cn(
                    'flex-shrink-0 h-7 w-9 md:h-4 md:w-7 p-0 rounded-sm transition-opacity',
                    'opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100',
                    dropdownOpen && 'opacity-100'
                  )}
                  aria-label="Document options"
                >
                  <MoreHorizontal className="size-4.5 md:size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="bottom">
                <TreeItemMenuItems items={menuItems} variant="dropdown" />
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </TreeItemWithContextMenu>
    </TreeItemInfoHoverCard>
  )
})
