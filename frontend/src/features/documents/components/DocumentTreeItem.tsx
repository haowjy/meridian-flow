import { useState } from 'react'
import { FileText, MoreHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/shared/components/ui/button'
import { TreeItemWithContextMenu } from '@/shared/components/TreeItemWithContextMenu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import { createDocumentMenuItems } from '../utils/menuBuilders'
import { InlineNameEditor } from './InlineNameEditor'
import { TreeItemMetadata } from './TreeItemMetadata'
import { useTreeSelection } from '../hooks/useTreeSelection'
import type { Document } from '../types/document'

interface DocumentTreeItemProps {
  document: Document
  isActive: boolean
  onClick: () => void
  onDelete?: () => void
  onRename?: () => void
  onAddAsReference?: () => void
  // Inline editing props
  isEditing?: boolean
  onSubmitName?: (name: string) => void
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
 */
export function DocumentTreeItem({
  document,
  isActive,
  onClick,
  onDelete,
  onRename,
  onAddAsReference,
  isEditing,
  onSubmitName,
  onCancelEdit,
  existingNames = [],
  editorMode = 'rename',
}: DocumentTreeItemProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const { toggleSelection, clearSelection } = useTreeSelection()

  const menuItems = createDocumentMenuItems({
    onRename,
    onDelete,
    onAddAsReference,
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
        <FileText className="size-4 flex-shrink-0" />
        <InlineNameEditor
          initialValue={document.name}
          existingNames={existingNames}
          onSubmit={onSubmitName}
          onCancel={onCancelEdit}
          mode={editorMode}
          extension={document.extension}
        />
      </div>
    )
  }

  // Render dropdown menu items
  const renderDropdownItems = () => (
    <>
      {menuItems.map((item, index) => {
        const showSeparatorBefore =
          item.separator === 'before' || item.separator === 'both'
        const showSeparatorAfter =
          item.separator === 'after' || item.separator === 'both'

        return (
          <div key={item.id}>
            {showSeparatorBefore && index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem
              onSelect={item.onSelect}
              variant={item.variant}
              disabled={item.disabled}
            >
              {item.icon}
              {item.label}
            </DropdownMenuItem>
            {showSeparatorAfter && index < menuItems.length - 1 && (
              <DropdownMenuSeparator />
            )}
          </div>
        )
      })}
    </>
  )

  return (
    <TreeItemWithContextMenu menuItems={menuItems}>
      <div
        role="button"
        tabIndex={0}
        onClick={(e) => {
          // Modifier key pressed → toggle selection
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault()
            e.stopPropagation()
            toggleSelection(document.id)
            return
          }

          // No modifier → clear selection and navigate
          clearSelection()
          onClick()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            clearSelection()
            onClick()
          }
        }}
        className={cn(
          'group flex w-full items-center gap-2 rounded-sm px-2.5 py-2 md:py-1 text-left text-sm transition-colors',
          'hover:bg-hover',
          isActive && 'bg-sidebar-accent/50 font-medium'
        )}
        aria-label={`Open document: ${document.filename}`}
        aria-current={isActive ? 'page' : undefined}
      >
        <FileText className="size-4 flex-shrink-0" />
        <span className="truncate flex-1">{document.filename}</span>

        {/* Metadata - word count, last edited */}
        <TreeItemMetadata
          type="document"
          wordCount={document.wordCount}
          updatedAt={document.updatedAt}
        />

        {/* "..." button - visible on hover or always on mobile */}
        {hasMenuItems && (
          <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  'flex-shrink-0 h-7 w-7 md:h-4 md:w-4 p-0 rounded-sm transition-opacity',
                  'opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100',
                  dropdownOpen && 'opacity-100'
                )}
                aria-label="Document options"
              >
                <MoreHorizontal className="size-4.5 md:size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="bottom">
              {renderDropdownItems()}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </TreeItemWithContextMenu>
  )
}
