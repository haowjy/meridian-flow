import { useState, useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { CollapsiblePanel } from './CollapsiblePanel'
import { PanelLayout } from './PanelLayout'
import {
  useUIStore,
  selectEffectiveLeftCollapsed,
  selectEffectiveRightCollapsed,
} from '@/core/stores/useUIStore'
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
 * Panel visibility behavior:
 * - Waits for localStorage hydration before computing state (prevents flicker)
 * - Auto: collapsed while data is loading, auto-expands when ready
 * - User override takes precedence (can expand during loading or collapse after ready)
 * - Ready state is set by data loaders (useThreadsForProject, useTreeStore.loadTree)
 */
export function ThreePanelLayout({ panels, className }: LayoutStrategyProps) {
  // Track hydration state using Zustand's built-in persist API
  // This prevents flash of wrong panel state before localStorage values are loaded
  const [hasHydrated, setHasHydrated] = useState(useUIStore.persist.hasHydrated())

  useEffect(() => {
    // Subscribe to hydration completion
    const unsub = useUIStore.persist.onFinishHydration(() => {
      setHasHydrated(true)
    })
    return unsub
  }, [])

  // Subscribe to effective collapsed state (handles ready state + user override)
  const {
    effectiveLeftCollapsed,
    effectiveRightCollapsed,
    toggleLeftPanel,
    toggleRightPanel,
  } = useUIStore(useShallow((s) => ({
    // Before hydration: default to collapsed to prevent jitter
    // After hydration: use the computed effective state
    effectiveLeftCollapsed: hasHydrated ? selectEffectiveLeftCollapsed(s) : true,
    effectiveRightCollapsed: hasHydrated ? selectEffectiveRightCollapsed(s) : true,
    toggleLeftPanel: s.toggleLeftPanel,
    toggleRightPanel: s.toggleRightPanel,
  })))

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
