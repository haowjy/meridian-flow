import { ReactNode, useState } from 'react'
import { Folder, FolderOpen, MoreHorizontal } from 'lucide-react'
import { Collapsible, CollapsibleContent } from '@/shared/components/ui/collapsible'
import { TreeItemWithContextMenu } from '@/shared/components/TreeItemWithContextMenu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import { createFolderMenuItems } from '../utils/menuBuilders'
import { InlineNameEditor } from './InlineNameEditor'
import { cn } from '@/lib/utils'
import type { Folder as FolderType } from '@/features/folders/types/folder'

interface FolderTreeItemProps {
  folder: FolderType
  isExpanded: boolean
  onToggle: () => void
  children: ReactNode
  onCreateDocument?: () => void
  onCreateFolder?: () => void
  onImport?: () => void
  onDelete?: () => void
  onRename?: () => void
  // Inline editing props
  isEditing?: boolean
  onSubmitName?: (name: string) => void
  onCancelEdit?: () => void
  existingNames?: string[]
}

/**
 * Recursive collapsible folder component.
 * Can contain other FolderTreeItems or DocumentTreeItems as children.
 * Right-click for context menu with create/manage actions.
 */
export function FolderTreeItem({
  folder,
  isExpanded,
  onToggle,
  children,
  onCreateDocument,
  onCreateFolder,
  onImport,
  onDelete,
  onRename,
  isEditing,
  onSubmitName,
  onCancelEdit,
  existingNames = [],
}: FolderTreeItemProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false)

  const menuItems = createFolderMenuItems({
    onCreateDocument,
    onCreateFolder,
    onImport,
    onRename,
    onDelete,
  })

  const hasMenuItems = menuItems.length > 0
  const FolderIcon = isExpanded ? FolderOpen : Folder

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

  // When editing, render inline editor without context menu or collapsible trigger
  if (isEditing && onSubmitName && onCancelEdit) {
    return (
      <Collapsible open={isExpanded} onOpenChange={onToggle}>
        <div
          className={cn(
            'flex w-full items-center gap-1.5 rounded-sm px-2.5 py-1 text-left text-xs md:text-sm'
          )}
        >
          <FolderIcon className="size-3.5 flex-shrink-0" />
          <InlineNameEditor
            initialValue={folder.name}
            existingNames={existingNames}
            onSubmit={onSubmitName}
            onCancel={onCancelEdit}
          />
        </div>

        <CollapsibleContent className="overflow-hidden transition-all data-[state=open]:animate-accordion-down data-[state=closed]:animate-accordion-up">
          <div className="tree-children">{children}</div>
        </CollapsibleContent>
      </Collapsible>
    )
  }

  return (
    <Collapsible open={isExpanded} onOpenChange={onToggle}>
      <TreeItemWithContextMenu menuItems={menuItems}>
        <div
          role="button"
          tabIndex={0}
          onClick={onToggle}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onToggle()
            }
          }}
          className={cn(
            'flex w-full items-center gap-1.5 rounded-sm px-2.5 py-1 text-left text-xs md:text-sm transition-colors',
            'hover:bg-hover',
            'group'
          )}
          aria-label={`${isExpanded ? 'Collapse' : 'Expand'} folder: ${folder.name}`}
          aria-expanded={isExpanded}
        >
          <FolderIcon className="size-3.5 flex-shrink-0" />
          <span className="truncate font-medium flex-1">{folder.name}</span>

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
                  aria-label="Folder options"
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

      <CollapsibleContent className="overflow-hidden transition-all data-[state=open]:animate-accordion-down data-[state=closed]:animate-accordion-up">
        <div className="tree-children">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}
