'use client'

import type { ReactNode } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import type { UserMenuItemConfig } from '../types'

/**
 * Props receive menu items - Open/Closed principle.
 * Add new items by passing different array, not modifying this component.
 */
interface UserMenuProps {
  trigger: ReactNode
  items: UserMenuItemConfig[]
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
}

/**
 * Menu behavior component.
 * Single Responsibility: Render dropdown menu with provided items.
 * Open/Closed: Items are injected, not hardcoded.
 */
export function UserMenu({
  trigger,
  items,
  side = 'top',
  align = 'start',
}: UserMenuProps) {
  if (items.length === 0) {
    return <>{trigger}</>
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={align}>
        {items.map((item, index) => {
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
                {item.icon && <span className="mr-2">{item.icon}</span>}
                <span>{item.label}</span>
              </DropdownMenuItem>
              {showSeparatorAfter && index < items.length - 1 && (
                <DropdownMenuSeparator />
              )}
            </div>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
