import { MessagesSquare } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/shared/components/ui/button'
import { useUIStore, selectEffectiveLeftCollapsed } from '@/core/stores/useUIStore'

/**
 * Edge toggle for the Flow (thread list) panel.
 * Anchored at the far-left rail; variant indicates collapsed/open state.
 */
export function FlowEdgeToggle() {
  const {
    isCollapsed,
    toggleLeftPanel,
  } = useUIStore(useShallow((s) => ({
    isCollapsed: selectEffectiveLeftCollapsed(s),
    toggleLeftPanel: s.toggleLeftPanel,
  })))

  return (
    <Button
      variant={isCollapsed ? 'outline' : 'ghost'}
      size="icon"
      onClick={toggleLeftPanel}
      aria-pressed={!isCollapsed}
      aria-label={isCollapsed ? 'Show thread list' : 'Hide thread list'}
    >
      <MessagesSquare className="size-4" />
    </Button>
  )
}
