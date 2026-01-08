import { useIsMobile } from './useIsMobile'
import { ThreePanelLayout } from '@/shared/components/layout/ThreePanelLayout'
import { MobileTabLayout } from '@/shared/components/layout/MobileTabLayout'
import type { LayoutStrategyComponent } from '@/shared/components/layout/types'

/**
 * Hook that returns the appropriate layout strategy based on viewport.
 *
 * Returns:
 * - Desktop (>=768px): ThreePanelLayout - resizable three-panel layout
 * - Mobile (<768px): MobileTabLayout - single panel with bottom tab nav
 *
 * This allows the WorkspaceLayout to be viewport-agnostic and simply
 * pass panel content to whatever strategy is appropriate.
 */
export function useLayoutStrategy(): LayoutStrategyComponent {
  const isMobile = useIsMobile()

  if (isMobile) {
    return MobileTabLayout
  }

  return ThreePanelLayout
}
