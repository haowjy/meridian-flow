import { useShallow } from 'zustand/react/shallow'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/core/stores/useUIStore'
import { MobileBottomNav } from './MobileBottomNav'
import type { LayoutStrategyProps } from './types'

/**
 * Mobile tab layout strategy.
 * Shows one panel at a time with bottom tab navigation.
 *
 * Layout:
 * ┌─────────────────────────────┐
 * │      [Active Panel]         │
 * │                             │
 * ├─────────────────────────────┤
 * │  Chats | Chat | Document    │
 * └─────────────────────────────┘
 *
 * Uses mobileActivePanel from UIStore to track which panel is visible.
 */
export function MobileTabLayout({ panels, className }: LayoutStrategyProps) {
  const { mobileActivePanel, setMobileActivePanel } = useUIStore(
    useShallow((s) => ({
      mobileActivePanel: s.mobileActivePanel,
      setMobileActivePanel: s.setMobileActivePanel,
    }))
  )

  // Render the active panel
  const renderActivePanel = () => {
    switch (mobileActivePanel) {
      case 'chatList':
        return panels.chatList
      case 'activeChat':
        return panels.activeChat
      case 'document':
        return panels.documentPanel
      default:
        return panels.activeChat
    }
  }

  return (
    <div
      className={cn(
        'flex h-full flex-col',
        className
      )}
    >
      {/* Panel content area */}
      <div
        id={`panel-${mobileActivePanel}`}
        role="tabpanel"
        aria-labelledby={`tab-${mobileActivePanel}`}
        className="flex-1 overflow-hidden"
      >
        {renderActivePanel()}
      </div>

      {/* Bottom navigation */}
      <MobileBottomNav
        activePanel={mobileActivePanel}
        onPanelChange={setMobileActivePanel}
      />
    </div>
  )
}
