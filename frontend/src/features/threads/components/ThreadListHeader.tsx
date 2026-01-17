import { Logo } from '@/shared/components'
import { SidebarToggle } from '@/shared/components/layout/SidebarToggle'
import { MobileNavButton } from '@/shared/components/layout/MobileNavButton'
import { useUIStore } from '@/core/stores/useUIStore'

interface ThreadListHeaderProps {
  onBrandClick?: () => void
}

/**
 * Header for the thread list panel.
 *
 * Single responsibility:
 * - Render sidebar toggle + centered logo.
 */
export function ThreadListHeader({ onBrandClick }: ThreadListHeaderProps) {
  const setMobileActivePanel = useUIStore((s) => s.setMobileActivePanel)

  return (
    <div className="thread-pane-header flex h-12 items-center px-2 sm:px-3">
      {/* Left: Toggle Sidebar (desktop only, hidden on mobile via SidebarToggle) */}
      <SidebarToggle side="left" />

      {/* Center: Logo (takes remaining space, centered) */}
      <div className="flex-1 flex justify-center">
        {onBrandClick ? (
          <button
            type="button"
            onClick={onBrandClick}
            className="cursor-pointer transition-opacity hover:opacity-80"
            aria-label="Back to projects"
          >
            <Logo variant="compact" size={32} mono />
          </button>
        ) : (
          <Logo variant="compact" size={32} mono />
        )}
      </div>

      {/* Right: Mobile nav to thread, desktop spacer */}
      <MobileNavButton
        icon="thread"
        onClick={() => setMobileActivePanel('activeThread')}
      />
      {/* Desktop spacer to balance the toggle (hidden on mobile via md:block) */}
      <div className="hidden size-8 md:block" />
    </div>
  )
}
