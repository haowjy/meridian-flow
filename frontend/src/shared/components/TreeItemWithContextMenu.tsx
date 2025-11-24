import { ReactNode } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu'

export interface ContextMenuItemConfig {
  id: string
  label: string
  onSelect: () => void
  variant?: 'default' | 'destructive'
  icon?: ReactNode
  separator?: 'before' | 'after' | 'both'
  disabled?: boolean
  shortcut?: string
}

interface TreeItemWithContextMenuProps {
  children: ReactNode
  menuItems: ContextMenuItemConfig[]
}

/**
 * Reusable wrapper that adds a context menu to any tree item.
 * Follows Open/Closed Principle - extend by passing different menu items.
 *
 * @example
 * <TreeItemWithContextMenu
 *   menuItems={[
 *     { id: 'rename', label: 'Rename', onSelect: handleRename },
 *     { id: 'delete', label: 'Delete', onSelect: handleDelete, variant: 'destructive', separator: 'before' }
 *   ]}
 * >
 *   <button>Tree Item Content</button>
 * </TreeItemWithContextMenu>
 */
export function TreeItemWithContextMenu({
  children,
  menuItems,
}: TreeItemWithContextMenuProps) {
  if (menuItems.length === 0) {
    return <>{children}</>
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {menuItems.map((item, index) => {
          const showSeparatorBefore =
            item.separator === 'before' || item.separator === 'both'
          const showSeparatorAfter =
            item.separator === 'after' || item.separator === 'both'

          return (
            <div key={item.id}>
              {showSeparatorBefore && index > 0 && <ContextMenuSeparator />}
              <ContextMenuItem
                onSelect={item.onSelect}
                variant={item.variant}
                disabled={item.disabled}
              >
                {item.icon && <span className="mr-2">{item.icon}</span>}
                <span>{item.label}</span>
                {item.shortcut && (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {item.shortcut}
                  </span>
                )}
              </ContextMenuItem>
              {showSeparatorAfter && index < menuItems.length - 1 && (
                <ContextMenuSeparator />
              )}
            </div>
          )
        })}
      </ContextMenuContent>
    </ContextMenu>
  )
}
