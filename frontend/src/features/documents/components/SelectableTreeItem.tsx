import { memo } from 'react'
import { useTreeSelection } from '../hooks/useTreeSelection'
import { cn } from '@/lib/utils'

/**
 * Wraps any tree item with selection highlight.
 * Follows SRP: only handles visual selection feedback.
 * Follows OCP: extends functionality through composition, not modification.
 *
 * Tree items handle their own clicks and selection logic (via Cmd+Click).
 * This wrapper only adds visual highlight when item is selected.
 *
 * Memoized to prevent re-renders when parent tree re-renders.
 *
 * @example
 * <SelectableTreeItem id={document.id}>
 *   <DocumentTreeItem document={document} isActive={isActive} {...otherProps} />
 * </SelectableTreeItem>
 */

interface SelectableTreeItemProps {
  id: string
  children: React.ReactNode
}

export const SelectableTreeItem = memo(function SelectableTreeItem({ id, children }: SelectableTreeItemProps) {
  const { isSelected } = useTreeSelection()
  const selected = isSelected(id)

  return (
    <div
      className={cn(
        'flex items-center',
        selected && 'bg-accent/10 rounded-sm'
      )}
    >
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
})
