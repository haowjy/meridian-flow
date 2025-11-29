import { Logo } from '@/shared/components'
import { SidebarToggle } from '@/shared/components/layout/SidebarToggle'

interface ChatListHeaderProps {
  onBrandClick?: () => void
}

/**
 * Header for the chat list panel.
 *
 * Single responsibility:
 * - Render sidebar toggle + centered logo.
 */
export function ChatListHeader({ onBrandClick }: ChatListHeaderProps) {
  return (
    <div className="chat-pane-header flex h-12 items-center px-3">
      {/* Left: Toggle Sidebar */}
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

      {/* Right spacer to balance the toggle */}
      <div className="size-8" />
    </div>
  )
}
