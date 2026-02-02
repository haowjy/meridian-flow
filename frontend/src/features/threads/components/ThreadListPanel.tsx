import { useState, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Plus, Search } from 'lucide-react'
import { useThreadStore } from '@/core/stores/useThreadStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { useLoadingView } from '@/core/hooks'
import { useThreadsForProject } from '@/features/threads/hooks/useThreadsForProject'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { LeftPanelHeader } from '@/shared/components/layout'
import { buildThreadTree } from '../utils/buildThreadTree'
import { ThreadTree } from './ThreadTree'
import { DeleteThreadDialog } from './DeleteThreadDialog'
import { ThreadListEmpty } from './ThreadListEmpty'
import type { Thread } from '@/features/threads/types'

interface ThreadListPanelProps {
  projectId: string
  /** Callback after selecting a thread (e.g., for mobile navigation) */
  onThreadSelected?: () => void
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
export function ThreadListPanel({ projectId, onThreadSelected }: ThreadListPanelProps) {
  const { threads, status, isLoading } = useThreadsForProject(projectId)
  const view = useLoadingView({ status, hasData: threads.length > 0 })

  // State for search, delete dialog, and rename mode
  const [searchQuery, setSearchQuery] = useState('')
  const [threadToDelete, setThreadToDelete] = useState<Thread | null>(null)
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const { deleteThread, renameThread } = useThreadStore(useShallow((s) => ({
    deleteThread: s.deleteThread,
    renameThread: s.renameThread,
  })))

  const { activeThreadId, setActiveThread, bumpThreadFocusVersion, setLeftPanelView } = useUIStore(useShallow((s) => ({
    activeThreadId: s.activeThreadId,
    setActiveThread: s.setActiveThread,
    bumpThreadFocusVersion: s.bumpThreadFocusVersion,
    setLeftPanelView: s.setLeftPanelView,
  })))

  const handleNewThread = () => {
    // Clear active thread to show cold start UI - thread is created atomically with first message
    setActiveThread(null)
    // Always switch to chat view so the composer is visible after clicking "+"/New.
    // The rail owns navigation between "threads" and "chat".
    setLeftPanelView('chat')
    // Always refocus thread input, even if already in cold-start state.
    bumpThreadFocusVersion()
  }

  const handleSelectThread = (threadId: string) => {
    setActiveThread(threadId)
    // Selecting a thread should immediately show the active chat.
    setLeftPanelView('chat')
    // Actual turns/streaming load lives in center/ActiveThreadView, not here.
    // On mobile, navigate to chat tab after selection
    onThreadSelected?.()
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
  const nodes = buildThreadTree(threads)

  // Filter nodes based on search query
  const filteredNodes = useMemo(() => {
    if (!searchQuery.trim()) return nodes
    const query = searchQuery.toLowerCase()
    return nodes.filter(node =>
      node.title?.toLowerCase().includes(query)
    )
  }, [nodes, searchQuery])

  // Title as leading content
  const titleContent = (
    <span className="font-medium text-sm">Threads</span>
  )

  return (
    <div className="thread-pane flex h-full flex-col bg-background text-foreground">
      {/* Header with title only - search and new button moved to content area */}
      <div className="shrink-0 border-b">
        <LeftPanelHeader
          leading={titleContent}
        />
      </div>

      {/* Single scroll container */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
        {/* Max-width wrapper for readability when panel is wide */}
        <div className="w-full max-w-3xl mx-auto">
          {/* Search + New Thread row - sticky within content area */}
          <div className="flex items-center gap-2 px-3 py-2 sticky top-0 bg-background z-10">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
              <Input
                type="search"
                placeholder="Search threads..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 h-8 text-sm"
              />
            </div>
            <Button
              size="icon"
              aria-label="New thread"
              disabled={isLoading}
              onClick={handleNewThread}
              className="shrink-0 size-8"
            >
              <Plus className="size-4 md:size-3.5" />
            </Button>
          </div>

          {/* Thread List Content */}
          <div className="thread-pane-body">
          {view === 'content' && (
            <ThreadTree
              nodes={filteredNodes}
              activeThreadId={activeThreadId}
              isLoading={isLoading}
              renamingThreadId={renamingThreadId}
              onSelectThread={handleSelectThread}
              onRename={handleRename}
              onRenameSubmit={handleRenameSubmit}
              onRenameCancel={handleRenameCancel}
              onDelete={handleDeleteClick}
            />
          )}

          {view === 'empty' && (
            <ThreadListEmpty onNewThread={handleNewThread} />
          )}

          {view === 'error' && (
            <div className="p-4 text-sm text-muted-foreground">
              Failed to load threads.
            </div>
          )}
        </div>
        </div>
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
    </div>
  )
}
