import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useShallow } from 'zustand/react/shallow'
import { Plus } from 'lucide-react'
import { useThreadStore } from '@/core/stores/useThreadStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { useThreadsForProject } from '@/features/threads/hooks/useThreadsForProject'
import { HeaderGradientFade } from '@/core/components/HeaderGradientFade'
import { Button } from '@/shared/components/ui/button'
import { ThreadListHeader } from './ThreadListHeader'
import { ThreadList } from './ThreadList'
import { ThreadListEmpty } from './ThreadListEmpty'
import { ThreadListItemSkeleton } from './ThreadListItemSkeleton'
import { DeleteThreadDialog } from './DeleteThreadDialog'
import { useUserProfile, useAuthActions, UserMenuButton } from '@/features/auth'
import type { Thread } from '@/features/threads/types'

interface ThreadListPanelProps {
  projectId: string
}

/**
 * Left-pane thread panel.
 *
 * Responsibilities (single):
 * - Orchestrate thread list data + selection for the left sidebar.
 *
 * It does NOT:
 * - Know about turn/streaming details (center panel concern).
 * - Render thread contents (delegated to ActiveThreadView).
 */
export function ThreadListPanel({ projectId }: ThreadListPanelProps) {
  const navigate = useNavigate()
  const { threads, status, isLoading } = useThreadsForProject(projectId)
  const [showSkeleton, setShowSkeleton] = useState(false)

  // State for delete dialog and rename mode
  const [threadToDelete, setThreadToDelete] = useState<Thread | null>(null)
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const { deleteThread, renameThread } = useThreadStore(useShallow((s) => ({
    deleteThread: s.deleteThread,
    renameThread: s.renameThread,
  })))

  const { activeThreadId, setActiveThread, bumpThreadFocusVersion, setMobileActivePanel } = useUIStore(useShallow((s) => ({
    activeThreadId: s.activeThreadId,
    setActiveThread: s.setActiveThread,
    bumpThreadFocusVersion: s.bumpThreadFocusVersion,
    setMobileActivePanel: s.setMobileActivePanel,
  })))

  // User profile for bottom menu
  const { profile, status: profileStatus } = useUserProfile()
  const { signOut } = useAuthActions()

  // Skeleton delay: only show skeleton after 150ms if still loading
  useEffect(() => {
    let timer: NodeJS.Timeout | null = null

    if (status === 'loading') {
      timer = setTimeout(() => setShowSkeleton(true), 150)
    }

    return () => {
      if (timer) clearTimeout(timer)
      setShowSkeleton(false)
    }
  }, [status])

  const handleNewThread = () => {
    // Clear active thread to show cold start UI - thread is created atomically with first message
    setActiveThread(null)
    // Always refocus thread input, even if already in cold-start state.
    bumpThreadFocusVersion()
  }

  const handleSelectThread = (threadId: string) => {
    setActiveThread(threadId)
    setMobileActivePanel('activeThread') // Navigate to thread view on mobile
    // Actual turns/streaming load lives in center/ActiveThreadView, not here.
  }

  // Rename handlers
  const handleRename = (threadId: string) => {
    setRenamingThreadId(threadId)
  }

  const handleRenameSubmit = async (threadId: string, newTitle: string) => {
    try {
      await renameThread(threadId, newTitle)
    } finally {
      setRenamingThreadId(null)
    }
  }

  const handleRenameCancel = () => {
    setRenamingThreadId(null)
  }

  // Delete handlers
  const handleDeleteClick = (thread: Thread) => {
    setThreadToDelete(thread)
  }

  const handleDeleteConfirm = async () => {
    if (!threadToDelete) return

    setIsDeleting(true)
    try {
      await deleteThread(threadToDelete.id)
      // If we deleted the active thread, clear the selection
      if (activeThreadId === threadToDelete.id) {
        setActiveThread(null)
      }
      setThreadToDelete(null)
    } finally {
      setIsDeleting(false)
    }
  }

  const hasThreads = threads.length > 0

  const handleBrandClick = () => {
    navigate({ to: '/projects' })
  }

  return (
    <div className="thread-pane flex h-full flex-col bg-sidebar text-sidebar-foreground">
      {/* Single scroll container - scrollbar extends to top */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
        {/* Sticky Header + New Thread Button */}
        <div className="sticky top-0 z-10 bg-sidebar relative">
          <ThreadListHeader onBrandClick={handleBrandClick} />

          {/* New Thread Button */}
          <div className="px-3 pt-2">
            <Button
              className="w-full"
              disabled={isLoading}
              onClick={handleNewThread}
            >
              <Plus className="size-4 mr-2" />
              New Thread
            </Button>
          </div>

          <HeaderGradientFade variant="sidebar" />
        </div>

        {/* Thread List Content */}
        <div className="thread-pane-body pt-3">
          {/* Show skeleton only for true cold loads (no cached threads) */}
          {status === 'loading' && showSkeleton ? (
            <div className="thread-pane-scroll p-2 space-y-1">
              <ThreadListItemSkeleton />
              <ThreadListItemSkeleton />
              <ThreadListItemSkeleton />
            </div>
          ) : hasThreads ? (
            <ThreadList
              threads={threads}
              activeThreadId={activeThreadId}
              isLoading={isLoading}
              renamingThreadId={renamingThreadId}
              onSelectThread={handleSelectThread}
              onRename={handleRename}
              onRenameSubmit={handleRenameSubmit}
              onRenameCancel={handleRenameCancel}
              onDelete={handleDeleteClick}
            />
          ) : (
            <ThreadListEmpty onNewThread={handleNewThread} />
          )}
        </div>
      </div>

      {/* User profile menu at bottom of sidebar */}
      {profileStatus === 'authenticated' && profile && (
        <div className="shrink-0 border-t border-border p-2">
          <UserMenuButton
            profile={profile}
            onSettings={() => navigate({ to: '/settings' })}
            onSignOut={signOut}
            menuSide="top"
          />
        </div>
      )}

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
    </div>
  )
}
