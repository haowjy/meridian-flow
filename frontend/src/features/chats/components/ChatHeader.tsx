import type { Chat } from '@/features/chats/types'
import { Button } from '@/shared/components/ui/button'
import { MoreHorizontal } from 'lucide-react'
import { ChatBreadcrumb } from './ChatBreadcrumb'

import { useShallow } from 'zustand/react/shallow'
import { useUIStore } from '@/core/stores/useUIStore'
import { SidebarToggle } from '@/shared/components/layout/SidebarToggle'

interface ChatHeaderProps {
  chat?: Chat | null
  projectName?: string | null
}

/**
 * Header for the chat area.
 *
 * Single responsibility:
 * - Show chat title + affordances for future actions (rename, menu).
 */
export function ChatHeader({ chat, projectName }: ChatHeaderProps) {
  const chatTitle = chat?.title || null

  const { leftPanelCollapsed, rightPanelCollapsed } = useUIStore(useShallow((s) => ({
    leftPanelCollapsed: s.leftPanelCollapsed,
    rightPanelCollapsed: s.rightPanelCollapsed,
  })))

  return (
    <div className="chat-main-header h-12 px-3 flex items-center justify-between">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {/* Left Toggle: Only show if left panel is collapsed */}
        {leftPanelCollapsed && (
          <SidebarToggle side="left" className="shrink-0" />
        )}

        <div className="min-w-0 flex-1">
          <ChatBreadcrumb projectName={projectName} chatTitle={chatTitle} />
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {/* Placeholder for future actions: rename, delete, export */}
        {chat && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Chat menu"
          >
            <MoreHorizontal className="size-3" />
          </Button>
        )}

        {/* Right Toggle: Only show if right panel is collapsed */}
        {rightPanelCollapsed && (
          <SidebarToggle side="right" className="shrink-0" />
        )}
      </div>
    </div>
  )
}
