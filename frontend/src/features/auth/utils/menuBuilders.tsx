import { Settings, LogOut } from 'lucide-react'
import type { UserMenuItemConfig } from '../types'

/**
 * Handler interface for user menu actions.
 * Open/Closed: Add new handlers without modifying consumers.
 */
interface UserMenuHandlers {
  onSettings?: () => void
  onSignOut?: () => void
}

/**
 * Factory function for user menu items.
 * Open/Closed: Add new items by extending this, not modifying consumers.
 *
 * Menu structure:
 * - Settings
 * - --- separator ---
 * - Sign out (destructive)
 */
export function createUserMenuItems(
  handlers: UserMenuHandlers
): UserMenuItemConfig[] {
  const items: UserMenuItemConfig[] = []

  if (handlers.onSettings) {
    items.push({
      id: 'settings',
      label: 'Settings',
      icon: <Settings className="size-3.5" />,
      onSelect: handlers.onSettings,
    })
  }

  if (handlers.onSignOut) {
    items.push({
      id: 'sign-out',
      label: 'Sign out',
      icon: <LogOut className="size-3.5" />,
      onSelect: handlers.onSignOut,
      separator: 'before',
    })
  }

  return items
}
