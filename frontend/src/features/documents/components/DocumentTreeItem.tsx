import { useState } from 'react'
import { FileText, MoreHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
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
}: DocumentTreeItemProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false)

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
          'flex w-full items-center gap-2 rounded-sm px-2.5 py-1 text-left text-xs md:text-sm',
          isActive && 'bg-muted border-l-2 border-accent'
        )}
      >
        <FileText className="size-3.5 flex-shrink-0" />
        <InlineNameEditor
          initialValue={document.name}
          existingNames={existingNames}
          onSubmit={onSubmitName}
          onCancel={onCancelEdit}
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
              onClick={item.onSelect}
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
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onClick()
          }
        }}
        className={cn(
          'group flex w-full items-center gap-2 rounded-sm px-2.5 py-1 text-left text-xs md:text-sm transition-colors',
          'hover:bg-hover',
          isActive && 'bg-muted font-medium border-l-2 border-accent'
        )}
        aria-label={`Open document: ${document.name}`}
        aria-current={isActive ? 'page' : undefined}
      >
        <FileText className="size-3.5 flex-shrink-0" />
        <span className="truncate flex-1">{document.name}</span>

        {/* "..." button - visible on hover */}
        {hasMenuItems && (
          <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  'flex-shrink-0 p-0.5 rounded hover:bg-accent/50 transition-opacity',
                  'opacity-0 group-hover:opacity-100 focus:opacity-100',
                  dropdownOpen && 'opacity-100'
                )}
                aria-label="Document options"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
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
