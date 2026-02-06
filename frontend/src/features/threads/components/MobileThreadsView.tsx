import { useState } from 'react'
import { useUIStore } from '@/core/stores/useUIStore'
import { MobilePanelHeader, MobileMenuSheet } from '@/shared/components/layout'
import { ThreadListPanel } from './ThreadListPanel'

interface MobileThreadsViewProps {
  projectId: string
}

/**
 * Mobile wrapper for ThreadListPanel.
 *
 * Provides:
 * - Custom header with hamburger menu + left-aligned label
 * - Thread selection switches to chat tab (state-driven, not URL navigation)
 */
export function MobileThreadsView({ projectId }: MobileThreadsViewProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const setMobileActiveTab = useUIStore((s) => s.setMobileActiveTab)

  const handleThreadSelected = () => {
    // Switch to chat tab after selecting a thread (state-driven)
    setMobileActiveTab('chat')
  }

  return (
    <>
      <div className="flex h-full flex-col bg-background">
        {/* Mobile header with hamburger menu */}
        <MobilePanelHeader
          title="Threads"
          onMenuOpen={() => setMobileMenuOpen(true)}
        />

        {/* Thread list content */}
        <div className="flex-1 overflow-hidden">
          <ThreadListPanel
            projectId={projectId}
            onThreadSelected={handleThreadSelected}
          />
        </div>
      </div>

      <MobileMenuSheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen} inWorkspace />
    </>
  )
}
