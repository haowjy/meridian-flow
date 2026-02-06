import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/shared/components/ui/button'
import { PanelHeader } from '@/shared/components/layout/headers'
import { DocumentsToggle } from '@/shared/components/layout/DocumentsToggle'
import {
  useUIStore,
  selectEffectiveRightCollapsed,
} from '@/core/stores/useUIStore'
import { useThreadStore } from '@/core/stores/useThreadStore'
import { useThreadsForProject } from '@/features/threads/hooks/useThreadsForProject'
import { ThreadSelector } from './ThreadSelector'
import { DeleteThreadDialog } from './DeleteThreadDialog'
import type { Thread } from '@/features/threads/types'

interface ChatHeaderProps {
  projectId: string
  /** Make header sticky at top of scroll container (default: false) */
  sticky?: boolean
}

/**
 * Chat panel header for the two-panel layout.
 *
 * Contains:
 * - Thread selector dropdown (left) - switch between threads
 * - New thread button (right) - start a new conversation
 * - Documents toggle (far right) - show/hide documents panel
 *
 * Uses PanelHeader for consistent layout across all panel views.
 */
export function ChatHeader({ projectId, sticky = false }: ChatHeaderProps) {
  const [threadToDelete, setThreadToDelete] = useState<Thread | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const { threads, isLoading } = useThreadsForProject(projectId)
  const isDocsCollapsed = useUIStore(selectEffectiveRightCollapsed)

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

  // New thread button + Documents toggle as trailing content
  const trailingContent = (
    <>
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
      {/* Show toggle only when docs are collapsed - clicking opens docs on right */}
      {isDocsCollapsed && <DocumentsToggle direction="right" />}
    </>
  )

  return (
    <>
      {/* Desktop header only - mobile views provide their own headers */}
      {/* Sticky must be on wrapper div, not PanelHeader - CSS sticky requires the
          sticky element to be a direct child of the scrolling container */}
      <div className={cn(
        'hidden md:block',
        sticky && 'sticky top-0 z-20 bg-background'
      )}>
        <PanelHeader
          leading={threadSelector}
          trailing={trailingContent}
        />
      </div>

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
