import { ReactNode } from 'react'
import { Folder, FolderOpen } from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/shared/components/ui/collapsible'
import { TreeItemWithContextMenu } from '@/shared/components/TreeItemWithContextMenu'
import { createFolderMenuItems } from '../utils/menuBuilders'
import { cn } from '@/lib/utils'
import type { Folder as FolderType } from '@/features/folders/types/folder'

interface FolderTreeItemProps {
  folder: FolderType
  isExpanded: boolean
  onToggle: () => void
  children: ReactNode
  onCreateDocument?: () => void
  onCreateFolder?: () => void
  onDelete?: () => void
  onRename?: () => void
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
  onDelete,
  onRename,
}: FolderTreeItemProps) {
  const menuItems = createFolderMenuItems({
    onCreateDocument,
    onCreateFolder,
    onRename,
    onDelete,
  })

  return (
    <Collapsible open={isExpanded} onOpenChange={onToggle}>
      <TreeItemWithContextMenu menuItems={menuItems}>
        <CollapsibleTrigger
          className={cn(
            'flex w-full items-center gap-1.5 rounded-sm px-2.5 py-1 text-left text-xs md:text-sm transition-colors',
            'hover:bg-hover',
            'group'
          )}
          aria-label={`${isExpanded ? 'Collapse' : 'Expand'} folder: ${folder.name}`}
        >
          {isExpanded ? (
            <FolderOpen className="size-4 flex-shrink-0" />
          ) : (
            <Folder className="size-4 flex-shrink-0" />
          )}
          <span className="truncate font-medium">{folder.name}</span>
        </CollapsibleTrigger>
      </TreeItemWithContextMenu>

      <CollapsibleContent className="overflow-hidden transition-all data-[state=open]:animate-accordion-down data-[state=closed]:animate-accordion-up">
        <div className="tree-children">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}
