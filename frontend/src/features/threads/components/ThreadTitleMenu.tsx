import { useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'

interface ThreadTitleMenuProps {
  trigger: React.ReactNode
  onRename?: () => void
  onDelete?: () => void
  align?: 'start' | 'end'
  // Future: onExport?, onSettings?
}

/**
 * Reusable dropdown menu for thread actions (rename, delete).
 *
 * Single Responsibility: Renders the dropdown menu with action items.
 * Callbacks are provided by parent - this component doesn't know about stores.
 *
 * Used by: ThreadListItem (sidebar), ThreadHeader (center panel)
 */
export function ThreadTitleMenu({
  trigger,
  onRename,
  onDelete,
  align = 'end',
}: ThreadTitleMenuProps) {
  const [open, setOpen] = useState(false)

  // Don't render if no actions provided
  if (!onRename && !onDelete) {
    return null
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        {trigger}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        {onRename && (
          <DropdownMenuItem onClick={onRename}>
            <Pencil className="size-3.5" />
            Rename
          </DropdownMenuItem>
        )}
        {onRename && onDelete && <DropdownMenuSeparator />}
        {onDelete && (
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash2 className="size-3.5" />
            Delete
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
