import { ScrollArea } from '@/shared/components/ui/scroll-area'
import type { Thread } from '@/features/threads/types'
import { ThreadListItem } from './ThreadListItem'

interface ThreadListProps {
  threads: Thread[]
  activeThreadId: string | null
  isLoading: boolean
  renamingThreadId: string | null
  onSelectThread: (threadId: string) => void
  onRename: (threadId: string) => void
  onRenameSubmit: (threadId: string, newTitle: string) => void
  onRenameCancel: () => void
  onDelete: (thread: Thread) => void
}

/**
 * Pure list container for threads.
 *
 * Responsibilities:
 * - Layout, scrolling, and mapping threads → ThreadListItem.
 * - No data fetching or side effects.
 */
export function ThreadList({
  threads,
  activeThreadId,
  isLoading,
  renamingThreadId,
  onSelectThread,
  onRename,
  onRenameSubmit,
  onRenameCancel,
  onDelete,
}: ThreadListProps) {
  return (
    <ScrollArea className="thread-pane-scroll h-full">
      <div className="flex flex-col gap-1 p-1">
        {threads.map((thread) => (
          <ThreadListItem
            key={thread.id}
            thread={thread}
            isActive={thread.id === activeThreadId}
            isDisabled={isLoading}
            isRenaming={thread.id === renamingThreadId}
            onClick={() => onSelectThread(thread.id)}
            onRename={() => onRename(thread.id)}
            onRenameSubmit={(newTitle) => onRenameSubmit(thread.id, newTitle)}
            onRenameCancel={onRenameCancel}
            onDelete={() => onDelete(thread)}
          />
        ))}
      </div>
    </ScrollArea>
  )
}

