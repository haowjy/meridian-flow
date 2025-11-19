"use client"

import { Folder } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/shared/components/ui/button'
import { useUIStore } from '@/core/stores/useUIStore'

/**
 * Edge toggle for the Documents panel.
 * Lives at the far-right rail; variant reflects collapsed state.
 */
export function DocsEdgeToggle() {
  const {
    rightPanelCollapsed,
    toggleRightPanel,
  } = useUIStore(useShallow((s) => ({
    rightPanelCollapsed: s.rightPanelCollapsed,
    toggleRightPanel: s.toggleRightPanel,
  })))

  return (
    <Button
      variant={rightPanelCollapsed ? 'outline' : 'ghost'}
      size="icon"
      className="size-8"
      onClick={toggleRightPanel}
      aria-pressed={!rightPanelCollapsed}
      aria-label={rightPanelCollapsed ? 'Show documents panel' : 'Hide documents panel'}
    >
      <Folder className="size-4" />
    </Button>
  )
}
