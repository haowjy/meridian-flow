import { ReactNode } from 'react'
import { Folder, FolderOpen, ChevronRight } from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/shared/components/ui/collapsible'
import { cn } from '@/lib/utils'
import type { Folder as FolderType } from '@/features/folders/types/folder'

interface FolderTreeItemProps {
  folder: FolderType
  isExpanded: boolean
  onToggle: () => void
  children: ReactNode
}

/**
 * Recursive collapsible folder component.
 * Can contain other FolderTreeItems or DocumentTreeItems as children.
 */
export function FolderTreeItem({ folder, isExpanded, onToggle, children }: FolderTreeItemProps) {
  return (
    <Collapsible open={isExpanded} onOpenChange={onToggle}>
      <CollapsibleTrigger
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors',
          'hover:bg-accent hover:text-accent-foreground',
          'group'
        )}
        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} folder: ${folder.name}`}
      >
        <ChevronRight
          className={cn(
            'h-4 w-4 flex-shrink-0 transition-transform',
            isExpanded && 'rotate-90'
          )}
        />
        {isExpanded ? (
          <FolderOpen className="h-4 w-4 flex-shrink-0" />
        ) : (
          <Folder className="h-4 w-4 flex-shrink-0" />
        )}
        <span className="truncate font-medium">{folder.name}</span>
      </CollapsibleTrigger>

      <CollapsibleContent className="overflow-hidden transition-all data-[state=open]:animate-accordion-down data-[state=closed]:animate-accordion-up">
        <div className="pl-6">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}
