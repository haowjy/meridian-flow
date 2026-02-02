import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Plus } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { LeftPanelHeader } from '@/shared/components/layout'
import { useUIStore } from '@/core/stores/useUIStore'
import { useThreadStore } from '@/core/stores/useThreadStore'
import { useThreadsForProject } from '@/features/threads/hooks/useThreadsForProject'
import { ThreadSelector } from './ThreadSelector'
import { DeleteThreadDialog } from './DeleteThreadDialog'
import type { Thread } from '@/features/threads/types'

interface ChatHeaderProps {
  projectId: string
}

/**
 * Chat panel header for the two-panel layout.
 *
 * Contains:
 * - Thread selector dropdown (left) - switch between threads
 * - New thread button (right) - start a new conversation
 * - Documents toggle (far right) - show/hide documents panel
 *
 * Uses LeftPanelHeader for consistent layout across all left panel views.
 */
export function ChatHeader({ projectId }: ChatHeaderProps) {
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

  // Rename thread inline from dropdown
  const handleRename = async (threadId: string) => {
    const thread = threads.find((t) => t.id === threadId)
    if (!thread) return
    // Use simple prompt for now - can be replaced with inline editing later
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

  // Thread selector as leading content
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
      <LeftPanelHeader
        leading={threadSelector}
        trailing={newThreadButton}
      />

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
