import { useShallow } from 'zustand/react/shallow'
import { CollapsiblePanel } from './CollapsiblePanel'
import { PanelLayout } from './PanelLayout'
import { useUIStore } from '@/core/stores/useUIStore'
import { useThreadStore } from '@/core/stores/useThreadStore'
import { useTreeStore } from '@/core/stores/useTreeStore'
import type { LayoutStrategyProps } from './types'

/**
 * Three-panel desktop layout strategy.
 * Renders: [Thread List | Active Thread | Documents/Editor]
 *
 * Uses react-resizable-panels for adjustable widths.
 * Default sizes: 22% | 56% | 22% (when all expanded)
 *
 * This component is a LayoutStrategy implementation - it receives panel content
 * and decides how to arrange them. It reads collapse state from useUIStore.
 *
 * Loading behavior:
 * - Sidebars start collapsed during initial load (when status is 'idle' or 'loading')
 * - Auto-expand when data loads (status becomes 'success' or 'error')
 * - User can click expand button to force-show panel even during loading
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

  // Get loading states to determine if panels are ready
  const threadStatus = useThreadStore((s) => s.statusThreads)
  const treeStatus = useTreeStore((s) => s.status)

  // Panel is ready when not idle/loading (data has arrived or errored)
  const leftReady = threadStatus === 'success' || threadStatus === 'error'
  const rightReady = treeStatus === 'success' || treeStatus === 'error'

  // Effective collapsed = user collapsed OR not ready yet
  // When user manually expands (toggles), leftPanelCollapsed becomes false,
  // which overrides the loading state and expands the panel
  const effectiveLeftCollapsed = leftPanelCollapsed || !leftReady
  const effectiveRightCollapsed = rightPanelCollapsed || !rightReady

  const left = (
    <CollapsiblePanel
      side="left"
      collapsed={effectiveLeftCollapsed}
      onToggle={toggleLeftPanel}
    >
      {panels.threadList}
    </CollapsiblePanel>
  )

  const right = (
    <CollapsiblePanel
      side="right"
      collapsed={effectiveRightCollapsed}
      onToggle={toggleRightPanel}
    >
      {panels.documentPanel}
    </CollapsiblePanel>
  )

  return (
    <PanelLayout
      className={className}
      left={left}
      center={panels.activeThread}
      right={right}
      leftCollapsed={effectiveLeftCollapsed}
      rightCollapsed={effectiveRightCollapsed}
      onLeftCollapse={toggleLeftPanel}
      onRightCollapse={toggleRightPanel}
    />
  )
}
