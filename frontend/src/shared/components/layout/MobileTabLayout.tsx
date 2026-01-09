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

  return (
    <div
      className={cn(
        'flex h-full flex-col',
        className
      )}
    >
      {/* Panel content area */}
      <div className="flex-1 overflow-hidden">
        {/* Keep chat panels mounted to prevent re-fetch/reload when switching tabs on mobile. */}
        <div
          id="panel-chatList"
          role="tabpanel"
          aria-labelledby="tab-chatList"
          hidden={mobileActivePanel !== 'chatList'}
          className="h-full overflow-hidden"
        >
          {panels.chatList}
        </div>

        <div
          id="panel-activeChat"
          role="tabpanel"
          aria-labelledby="tab-activeChat"
          hidden={mobileActivePanel !== 'activeChat'}
          className="h-full overflow-hidden"
        >
          {panels.activeChat}
        </div>

        {/* Documents can be heavier (tree + editor). Mount content only when active. */}
        <div
          id="panel-document"
          role="tabpanel"
          aria-labelledby="tab-document"
          hidden={mobileActivePanel !== 'document'}
          className="h-full overflow-hidden"
        >
          {mobileActivePanel === 'document' ? panels.documentPanel : null}
        </div>
      </div>

      {/* Bottom navigation */}
      <MobileBottomNav
        activePanel={mobileActivePanel}
        onPanelChange={setMobileActivePanel}
      />
    </div>
  )
}
