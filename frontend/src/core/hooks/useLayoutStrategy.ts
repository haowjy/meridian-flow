import { useIsMobile } from "./useIsMobile";
import { TwoPanelLayout } from "@/shared/components/layout/TwoPanelLayout";
import { MobileLayout } from "@/shared/components/layout/MobileLayout";
import type { LayoutStrategyComponent } from "@/shared/components/layout/types";

/**
 * Hook that returns the appropriate layout strategy based on viewport.
 *
 * Returns:
 * - Desktop (>=768px): TwoPanelLayout - two-panel layout (chat left, documents right)
 * - Mobile (<768px): MobileLayout - Notion-style layout with top header and bottom tabs
 *
 * Design philosophy: Documents are the primary workspace for writers.
 * Chat panel (left) is collapsible assistant sidebar.
 *
 * This allows the WorkspaceLayout to be viewport-agnostic and simply
 * pass panel content to whatever strategy is appropriate.
 */
export function useLayoutStrategy(): LayoutStrategyComponent {
  const isMobile = useIsMobile();

  if (isMobile) {
    return MobileLayout;
  }

  return TwoPanelLayout;
}
