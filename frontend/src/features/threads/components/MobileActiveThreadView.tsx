import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Plus } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { MobilePanelHeader, MobileMenuSheet } from '@/shared/components/layout'
import { useUIStore } from '@/core/stores/useUIStore'
import { useThreadStore } from '@/core/stores/useThreadStore'
import { useThreadsForProject } from '@/features/threads/hooks/useThreadsForProject'
import { ThreadSelector } from './ThreadSelector'
import { DeleteThreadDialog } from './DeleteThreadDialog'
import { ActiveThreadView } from './ActiveThreadView'
import type { Thread } from '@/features/threads/types'

interface MobileActiveThreadViewProps {
  projectId: string
}

/**
 * Mobile wrapper for ActiveThreadView.
 *
 * Provides:
 * - MobileHeader with hamburger menu + ThreadSelector (same as desktop ChatHeader)
 * - New thread button
 * - MobileMenuSheet for navigation
 *
 * The desktop ChatHeader is hidden on mobile (via ActiveThreadView's responsive classes),
 * so this component provides the mobile-specific header with the same functionality.
 */
export function MobileActiveThreadView({ projectId }: MobileActiveThreadViewProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [threadToDelete, setThreadToDelete] = useState<Thread | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const { threads, isLoading } = useThreadsForProject(projectId)

  const {
    activeThreadId,
    setActiveThread,
    bumpThreadFocusVersion,
  } = useUIStore(useShallow((s) => ({
    activeThreadId: s.activeThreadId,
    setActiveThread: s.setActiveThread,
    bumpThreadFocusVersion: s.bumpThreadFocusVersion,
  })))

  const { renameThread, deleteThread } = useThreadStore(useShallow((s) => ({
    renameThread: s.renameThread,
    deleteThread: s.deleteThread,
  })))

  const activeThread = threads.find((t) => t.id === activeThreadId) ?? null

  const handleNewThread = () => {
    setActiveThread(null)
    bumpThreadFocusVersion()
  }

  const handleSelectThread = (threadId: string) => {
    setActiveThread(threadId)
  }

  const handleRename = async (threadId: string) => {
    const thread = threads.find((t) => t.id === threadId)
    if (!thread) return
    const newTitle = window.prompt('Rename thread', thread.title)
    if (newTitle && newTitle.trim() !== thread.title) {
      await renameThread(threadId, newTitle.trim())
    }
  }

  const handleDeleteClick = (thread: Thread) => {
    setThreadToDelete(thread)
  }

  const handleDeleteConfirm = async () => {
    if (!threadToDelete) return

    setIsDeleting(true)
    try {
      await deleteThread(threadToDelete.id)
      if (activeThreadId === threadToDelete.id) {
        setActiveThread(null)
      }
      setThreadToDelete(null)
    } finally {
      setIsDeleting(false)
    }
  }

  // Thread selector as leading content (same as desktop ChatHeader)
  const threadSelector = (
    <ThreadSelector
      threads={threads}
      activeThreadId={activeThreadId}
      activeThread={activeThread}
      isLoading={isLoading}
      onSelectThread={handleSelectThread}
      onNewThread={handleNewThread}
      onRename={handleRename}
      onDelete={handleDeleteClick}
    />
  )

  // New thread button as trailing content
  const newThreadButton = (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleNewThread}
      disabled={isLoading}
      aria-label="New thread"
      title="New thread"
    >
      <Plus className="size-4" />
    </Button>
  )

  return (
    <>
      <div className="flex h-full flex-col bg-background">
        {/* Mobile header with hamburger + ThreadSelector + new thread button */}
        <MobilePanelHeader
          leading={threadSelector}
          trailing={newThreadButton}
          onMenuOpen={() => setMobileMenuOpen(true)}
        />

        {/* Chat content */}
        <div className="flex-1 overflow-hidden">
          <ActiveThreadView projectId={projectId} />
        </div>
      </div>

      <MobileMenuSheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen} inWorkspace />

      {/* Delete confirmation dialog */}
      <DeleteThreadDialog
        thread={threadToDelete}
        open={threadToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setThreadToDelete(null)
        }}
        onConfirm={handleDeleteConfirm}
        isDeleting={isDeleting}
      />
    </>
  )
}
