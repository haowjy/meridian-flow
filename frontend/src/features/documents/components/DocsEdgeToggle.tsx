import { Folder } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/shared/components/ui/button'
import { useUIStore, selectEffectiveRightCollapsed } from '@/core/stores/useUIStore'

/**
 * Edge toggle for the Documents panel.
 * Lives at the far-right rail; variant reflects collapsed state.
 */
export function DocsEdgeToggle() {
  const {
    isCollapsed,
    toggleRightPanel,
  } = useUIStore(useShallow((s) => ({
    isCollapsed: selectEffectiveRightCollapsed(s),
    toggleRightPanel: s.toggleRightPanel,
  })))

  return (
    <Button
      variant={isCollapsed ? 'outline' : 'ghost'}
      size="icon"
      onClick={toggleRightPanel}
      aria-pressed={!isCollapsed}
      aria-label={isCollapsed ? 'Show documents panel' : 'Hide documents panel'}
    >
      <Folder className="size-4" />
    </Button>
  )
}
