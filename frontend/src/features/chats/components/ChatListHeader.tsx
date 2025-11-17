'use client'

import { Plus } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { LogoWordmark } from '@/shared/components'

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
    <div className="chat-pane-header flex items-center justify-between px-3 py-3">
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
      <Button
        size="icon"
        className="h-8 w-8"
        disabled={isLoading}
        onClick={onNewChat}
        aria-label="New chat"
      >
        <Plus className="h-4 w-4" />
      </Button>
    </div>
  )
}
