import { PanelLeft, PanelRight } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import {
  useUIStore,
  selectEffectiveLeftCollapsed,
  selectEffectiveRightCollapsed,
} from '@/core/stores/useUIStore'
import { useShallow } from 'zustand/react/shallow'
import { cn } from '@/lib/utils'

interface SidebarToggleProps {
  side: 'left' | 'right'
  className?: string
}

/**
 * Standardized sidebar toggle button.
 * Handles interaction with UI store and renders appropriate icon.
 */
export function SidebarToggle({ side, className }: SidebarToggleProps) {
  const { isCollapsed, toggle } = useUIStore(useShallow((s) => ({
    isCollapsed: side === 'left'
      ? selectEffectiveLeftCollapsed(s)
      : selectEffectiveRightCollapsed(s),
    toggle: side === 'left' ? s.toggleLeftPanel : s.toggleRightPanel,
  })))

  const label = isCollapsed ? `Expand ${side} sidebar` : `Collapse ${side} sidebar`

  const Icon = side === 'left' ? PanelLeft : PanelRight

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      // Mobile uses tab navigation (no sidebars).
      className={cn('hidden md:inline-flex', className)}
      aria-label={label}
      title={label}
    >
      <Icon className="size-4.5" />
    </Button>
  )
}
