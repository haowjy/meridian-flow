import { MessageCircle } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'

interface ThreadListEmptyProps {
  onNewThread: () => void
}

/**
 * Empty state for the thread list.
 *
 * Single responsibility:
 * - Explain that there are no threads yet and offer a clear call to action.
 */
export function ThreadListEmpty({ onNewThread }: ThreadListEmptyProps) {
  return (
    <div className="thread-pane-empty flex h-full flex-col items-center justify-center px-4 text-center text-xs text-muted-foreground">
      <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-full bg-muted text-foreground">
        <MessageCircle className="size-4" />
      </div>
      <p className="mb-1 font-medium text-foreground">
        Start a thread
      </p>
      <p className="mb-3 max-w-[220px]">
        Create a thread to brainstorm ideas, outline chapters, or ask questions about your project.
      </p>
      <Button size="sm" onClick={onNewThread}>
        New Thread
      </Button>
    </div>
  )
}

