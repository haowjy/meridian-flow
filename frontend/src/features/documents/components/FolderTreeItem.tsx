import { ReactNode, useState, memo } from 'react'
import { Folder, FolderOpen, MoreHorizontal } from 'lucide-react'
import { Collapsible, CollapsibleContent } from '@/shared/components/ui/collapsible'
import { TreeItemMenuItems } from '@/shared/components/TreeItemMenuItems'
import { TreeItemWithContextMenu } from '@/shared/components/TreeItemWithContextMenu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import { createFolderMenuItems } from '../utils/menuBuilders'
import { InlineNameEditor } from './InlineNameEditor'
import { TreeItemInfoHoverCard, HoverCardTrigger } from './tree-item-info/TreeItemInfoHoverCard'
import { useTreeSelection } from '../hooks/useTreeSelection'
import { cn } from '@/lib/utils'
import { Button } from '@/shared/components/ui/button'
import type { Folder as FolderType } from '@/features/folders/types/folder'

interface FolderTreeItemProps {
  folder: FolderType
  isExpanded: boolean
  children: ReactNode
  // Callbacks accept folderId for stable references (no inline arrows in parent)
  onToggle: (folderId: string) => void
  onCreateDocument?: (folderId: string) => void
  onCreateFolder?: (parentId: string) => void
  onImport?: (folderId: string) => void
  onRename?: (folderId: string) => void
  onDelete?: (folderId: string, folder: FolderType) => void
  onShowDetails?: (folderId: string, folder: FolderType, documentCount?: number, folderCount?: number) => void
  // Metadata for details dialog (passed through for stable callback)
  documentCount?: number
  folderCount?: number
  // Inline editing props
  isEditing?: boolean
  onSubmitName?: (folderId: string, name: string) => void
  onCancelEdit?: () => void
  existingNames?: string[]
  /**
   * Controls how the inline editor behaves.
   * - 'rename' (default): existing folder rename.
   * - 'create': new, temporary folder being created.
   */
  editorMode?: 'rename' | 'create'
}

/**
 * Recursive collapsible folder component.
 * Can contain other FolderTreeItems or DocumentTreeItems as children.
 * Right-click for context menu with create/manage actions.
 *
 * Memoized to prevent re-renders when parent tree re-renders.
 * Callbacks accept folder.id as first param for stable references.
 */
export const FolderTreeItem = memo(function FolderTreeItem({
  folder,
  isExpanded,
  onToggle,
  children,
  onCreateDocument,
  onCreateFolder,
  onImport,
  onDelete,
  onRename,
  onShowDetails,
  documentCount,
  folderCount,
  isEditing,
  onSubmitName,
  onCancelEdit,
  existingNames = [],
  editorMode = 'rename',
}: FolderTreeItemProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [contextMenuOpen, setContextMenuOpen] = useState(false)
  const { toggleSelection, clearSelection } = useTreeSelection()

  // Wrap callbacks to pass folder.id - these are only created when menu opens
  const menuItems = createFolderMenuItems({
    onDetails: onShowDetails ? () => onShowDetails(folder.id, folder, documentCount, folderCount) : undefined,
    onCreateDocument: onCreateDocument ? () => onCreateDocument(folder.id) : undefined,
    onCreateFolder: onCreateFolder ? () => onCreateFolder(folder.id) : undefined,
    onImport: onImport ? () => onImport(folder.id) : undefined,
    onRename: onRename ? () => onRename(folder.id) : undefined,
    onDelete: onDelete ? () => onDelete(folder.id, folder) : undefined,
  })

  const hasMenuItems = menuItems.length > 0
  const FolderIcon = isExpanded ? FolderOpen : Folder

  // When editing, render inline editor without context menu or collapsible trigger
  if (isEditing && onSubmitName && onCancelEdit) {
    return (
      <Collapsible open={isExpanded} onOpenChange={() => onToggle(folder.id)}>
        <div
          className={cn(
            'group flex w-full items-center gap-1.5 rounded-sm px-2.5 py-2 md:py-1 text-left text-sm'
          )}
        >
          <FolderIcon className="size-4 md:size-3.5 flex-shrink-0" />
          <InlineNameEditor
            initialValue={folder.name}
            existingNames={existingNames}
            onSubmit={(name) => onSubmitName(folder.id, name)}
            onCancel={onCancelEdit}
            mode={editorMode}
          />
        </div>

        <CollapsibleContent className="overflow-hidden">
          <div className="tree-children">{children}</div>
        </CollapsibleContent>
      </Collapsible>
    )
  }

  return (
    <Collapsible open={isExpanded} onOpenChange={() => onToggle(folder.id)}>
      <TreeItemInfoHoverCard type="folder" item={folder} documentCount={documentCount} folderCount={folderCount}>
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
            )}
          >
            <button
              type="button"
              onClick={(e) => {
                // Modifier key pressed → toggle selection
                if (e.metaKey || e.ctrlKey) {
                  e.preventDefault()
                  toggleSelection(folder.id)
                  return
                }

                // No modifier → clear selection and toggle folder
                clearSelection()
                onToggle(folder.id)
              }}
              className={cn(
                'flex flex-1 min-w-0 items-center gap-1.5 px-2.5 py-2 md:py-1',
                'cursor-default appearance-none bg-transparent border-none m-0 font-inherit text-inherit text-left'
              )}
              aria-label={`${isExpanded ? 'Collapse' : 'Expand'} folder: ${folder.name}`}
              aria-expanded={isExpanded}
            >
              <FolderIcon className="size-4 md:size-3.5 flex-shrink-0" />
              <span className="truncate font-medium">{folder.name}</span>
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
                    size="icon-lg"
                    disabled={contextMenuOpen}
                    className={cn(
                      'flex-shrink-0 h-7 w-9 md:h-4 md:w-7 p-0 rounded-sm transition-opacity',
                      'opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100',
                      dropdownOpen && 'opacity-100'
                    )}
                    aria-label="Folder options"
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

      <CollapsibleContent className="overflow-hidden">
        <div className="tree-children">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
})
