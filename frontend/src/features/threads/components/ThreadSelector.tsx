import { useState, useMemo } from 'react'
import { ChevronDown, MessageSquare, Sparkles, Pencil, Trash2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuLabel,
} from '@/shared/components/ui/dropdown-menu'
import { Button } from '@/shared/components/ui/button'
import { cn } from '@/lib/utils'
import type { Thread } from '@/features/threads/types'

interface ThreadSelectorProps {
  threads: Thread[]
  activeThreadId: string | null
  activeThread: Thread | null
  isLoading: boolean
  onSelectThread: (threadId: string) => void
  onNewThread: () => void
  onRename?: (threadId: string) => void
  onDelete?: (thread: Thread) => void
}

/**
 * Groups threads by relative time periods.
 * Uses setDate() instead of millisecond math to handle DST transitions correctly.
 */
function groupThreadsByTime(threads: Thread[]): Map<string, Thread[]> {
  const now = new Date()

  // Use local midnight boundaries (handles DST automatically)
  // setDate() correctly handles month boundaries and DST transitions
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)

  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)

  const lastWeek = new Date(today)
  lastWeek.setDate(lastWeek.getDate() - 7)

  const lastMonth = new Date(today)
  lastMonth.setDate(lastMonth.getDate() - 30)

  const groups = new Map<string, Thread[]>()
  groups.set('Today', [])
  groups.set('Yesterday', [])
  groups.set('Last 7 days', [])
  groups.set('Last 30 days', [])
  groups.set('Older', [])

  for (const thread of threads) {
    const threadDate = new Date(thread.updatedAt)
    if (threadDate >= today) {
      groups.get('Today')!.push(thread)
    } else if (threadDate >= yesterday) {
      groups.get('Yesterday')!.push(thread)
    } else if (threadDate >= lastWeek) {
      groups.get('Last 7 days')!.push(thread)
    } else if (threadDate >= lastMonth) {
      groups.get('Last 30 days')!.push(thread)
    } else {
      groups.get('Older')!.push(thread)
    }
  }

  // Remove empty groups
  for (const [key, value] of groups) {
    if (value.length === 0) {
      groups.delete(key)
    }
  }

  return groups
}

/**
 * Thread selector dropdown for the chat header.
 *
 * Shows current thread title with dropdown to switch between threads.
 * Threads are grouped by time period (Today, Yesterday, etc.).
 *
 * Future-ready for session groups and thread branching.
 */
export function ThreadSelector({
  threads,
  activeThreadId,
  activeThread,
  isLoading,
  onSelectThread,
  onNewThread,
  onRename,
  onDelete,
}: ThreadSelectorProps) {
  const [open, setOpen] = useState(false)

  const groupedThreads = useMemo(() => groupThreadsByTime(threads), [threads])

  const displayTitle = activeThread?.title || 'New Thread'

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1 px-2 font-medium max-w-[200px] truncate"
          disabled={isLoading}
        >
          <span className="truncate">{displayTitle}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[280px]">
        {/* New Thread option */}
        <DropdownMenuItem onClick={onNewThread}>
          <Sparkles className="size-4.5 text-primary" />
          <span className="font-medium">New Thread</span>
        </DropdownMenuItem>

        {threads.length > 0 && <DropdownMenuSeparator />}

        {/* Grouped threads */}
        {Array.from(groupedThreads.entries()).map(([groupLabel, groupThreads]) => (
          <div key={groupLabel}>
            <DropdownMenuLabel className="text-muted-foreground">
              {groupLabel}
            </DropdownMenuLabel>
            {groupThreads.map((thread) => (
              <DropdownMenuItem
                key={thread.id}
                className={cn(
                  'flex items-center justify-between gap-2 group pr-1',
                  thread.id === activeThreadId && 'bg-primary/10'
                )}
                onClick={() => {
                  onSelectThread(thread.id)
                  setOpen(false)
                }}
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{thread.title || 'Untitled'}</span>
                  {thread.id === activeThreadId && (
                    <span className="text-primary text-[10px]">✓</span>
                  )}
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  {onRename && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        'h-4 w-5 p-0 rounded-sm transition-opacity',
                        'opacity-0 group-hover:opacity-100'
                      )}
                      onClick={(e) => {
                        e.stopPropagation()
                        onRename(thread.id)
                        setOpen(false)
                      }}
                      aria-label="Rename thread"
                    >
                      <Pencil className="size-3" />
                    </Button>
                  )}
                  {onDelete && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        'h-4 w-5 p-0 rounded-sm transition-opacity text-error hover:text-error',
                        'opacity-0 group-hover:opacity-100'
                      )}
                      onClick={(e) => {
                        e.stopPropagation()
                        onDelete(thread)
                        setOpen(false)
                      }}
                      aria-label="Delete thread"
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  )}
                </div>
              </DropdownMenuItem>
            ))}
          </div>
        ))}

        {threads.length === 0 && !isLoading && (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">
            No threads yet
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
