import { ReactNode } from 'react'
import { HeaderGradientFade } from '@/core/components/HeaderGradientFade'
import { DocumentsToggle } from './DocumentsToggle'
import {
  useUIStore,
  selectEffectiveRightCollapsed,
} from '@/core/stores/useUIStore'

interface LeftPanelHeaderProps {
  /**
   * Content for the leading area (left side).
   * Can be a selector (e.g., ThreadSelector), title text, or any ReactNode.
   */
  leading: ReactNode
  /**
   * Content for the trailing area (between leading and documents toggle).
   * Typically action buttons like "New Thread" or other controls.
   */
  trailing?: ReactNode
}

/**
 * Desktop-only header component for left panel views.
 *
 * Provides consistent layout across:
 * - ChatHeader (ThreadSelector + New button)
 * - ThreadListPanel ("Threads" label + New button)
 * - ProjectSettingsPanel ("Project Settings" label)
 *
 * Design Philosophy:
 * - Documents toggle appears contextually based on panel state
 * - When docs collapsed: toggle appears here (left panel) to open docs
 * - When docs expanded: toggle appears on right panel (ProjectHeader) to close docs
 * - Consistent height (h-14 = 56px) and styling across all views
 *
 * Note: Mobile views (MobileThreadsView, MobileDocumentView, etc.) provide their
 * own headers via MobileHeader, so this component renders nothing on mobile.
 *
 * Layout (desktop):
 * [leading content] ----flex grow---- [trailing?] [DocumentsToggle?]
 */
export function LeftPanelHeader({ leading, trailing }: LeftPanelHeaderProps) {
  const isDocsCollapsed = useUIStore(selectEffectiveRightCollapsed)

  // Desktop header only - mobile views provide their own headers
  return (
    <div className="hidden md:flex items-center justify-between px-3 h-14 relative">
      {/* Leading content (selector, title, etc.) */}
      <div className="flex items-center gap-1 min-w-0 flex-1">
        {leading}
      </div>

      {/* Trailing actions + Documents toggle (only when docs collapsed) */}
      <div className="flex items-center gap-1 shrink-0">
        {trailing}
        {/* Show toggle only when docs are collapsed - clicking opens docs on right */}
        {isDocsCollapsed && <DocumentsToggle direction="right" />}
      </div>
      <HeaderGradientFade />
    </div>
  )
}
