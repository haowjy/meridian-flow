import { Plus } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { LogoWordmark } from '@/shared/components'
import { SidebarToggle } from '@/shared/components/layout/SidebarToggle'

interface ChatListHeaderProps {
  projectId: string
  isLoading: boolean
  onNewChat: () => void
  onBrandClick?: () => void
}

/**
 * Header for the chat list panel.
 *
 * Single responsibility:
 * - Render title + “New Chat” affordance.
 *
 * Reusable: can be swapped out or reused in other layouts that
 * need a minimal chat header.
 */
export function ChatListHeader({
  isLoading,
  onNewChat,
  onBrandClick,
}: ChatListHeaderProps) {
  return (
    <div className="chat-pane-header flex h-12 items-center justify-between px-3 relative">
      {/* Left: Toggle Sidebar */}
      <SidebarToggle side="left" />

      {/* Center: Logo */}
      <div className="absolute left-1/2 -translate-x-1/2 flex items-center justify-center">
        {onBrandClick ? (
          <button
            type="button"
            onClick={onBrandClick}
            className="min-w-0 text-left cursor-pointer transition-opacity hover:opacity-80"
            aria-label="Back to projects"
          >
            <LogoWordmark secondaryLabel="Flow" />
          </button>
        ) : (
          <LogoWordmark secondaryLabel="Flow" />
        )}
      </div>

      {/* Right: New Chat */}
      <Button
        size="icon"
        className="size-5"
        disabled={isLoading}
        onClick={onNewChat}
        aria-label="New chat"
      >
        <Plus className="size-3" />
      </Button>
    </div>
  )
}
