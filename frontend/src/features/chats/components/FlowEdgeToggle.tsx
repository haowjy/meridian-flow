import { MessagesSquare } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/shared/components/ui/button'
import { useUIStore } from '@/core/stores/useUIStore'

/**
 * Edge toggle for the Flow (chat list) panel.
 * Anchored at the far-left rail; variant indicates collapsed/open state.
 */
export function FlowEdgeToggle() {
  const {
    leftPanelCollapsed,
    toggleLeftPanel,
  } = useUIStore(useShallow((s) => ({
    leftPanelCollapsed: s.leftPanelCollapsed,
    toggleLeftPanel: s.toggleLeftPanel,
  })))

  return (
    <Button
      variant={leftPanelCollapsed ? 'outline' : 'ghost'}
      size="icon"
      className="size-8"
      onClick={toggleLeftPanel}
      aria-pressed={!leftPanelCollapsed}
      aria-label={leftPanelCollapsed ? 'Show chat list' : 'Hide chat list'}
    >
      <MessagesSquare className="size-4" />
    </Button>
  )
}
