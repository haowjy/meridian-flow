import { useShallow } from 'zustand/react/shallow'
import { CollapsiblePanel } from './CollapsiblePanel'
import { PanelLayout } from './PanelLayout'
import { useUIStore } from '@/core/stores/useUIStore'
import type { LayoutStrategyProps } from './types'

/**
 * Three-panel desktop layout strategy.
 * Renders: [Chat List | Active Chat | Documents/Editor]
 *
 * Uses react-resizable-panels for adjustable widths.
 * Default sizes: 22% | 56% | 22% (when all expanded)
 *
 * This component is a LayoutStrategy implementation - it receives panel content
 * and decides how to arrange them. It reads collapse state from useUIStore.
 */
export function ThreePanelLayout({ panels, className }: LayoutStrategyProps) {
  // Subscribe to collapse state for this layout
  const {
    leftPanelCollapsed,
    rightPanelCollapsed,
    toggleLeftPanel,
    toggleRightPanel,
  } = useUIStore(useShallow((s) => ({
    leftPanelCollapsed: s.leftPanelCollapsed,
    rightPanelCollapsed: s.rightPanelCollapsed,
    toggleLeftPanel: s.toggleLeftPanel,
    toggleRightPanel: s.toggleRightPanel,
  })))

  const left = (
    <CollapsiblePanel
      side="left"
      collapsed={leftPanelCollapsed}
      onToggle={toggleLeftPanel}
    >
      {panels.chatList}
    </CollapsiblePanel>
  )

  const right = (
    <CollapsiblePanel
      side="right"
      collapsed={rightPanelCollapsed}
      onToggle={toggleRightPanel}
    >
      {panels.documentPanel}
    </CollapsiblePanel>
  )

  return (
    <PanelLayout
      className={className}
      left={left}
      center={panels.activeChat}
      right={right}
      leftCollapsed={leftPanelCollapsed}
      rightCollapsed={rightPanelCollapsed}
      onLeftCollapse={toggleLeftPanel}
      onRightCollapse={toggleRightPanel}
    />
  )
}
