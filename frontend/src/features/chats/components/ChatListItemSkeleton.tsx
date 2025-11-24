import { Skeleton } from '@/shared/components/ui/skeleton'
import { cn } from '@/lib/utils'

export function ChatListItemSkeleton() {
  return (
    <div
      className={cn(
        'chat-list-item flex w-full items-center gap-2 rounded px-3 py-1.5',
        'pointer-events-none'
      )}
      aria-hidden="true"
    >
      <div className="flex flex-1 flex-col gap-1 overflow-hidden">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-24" />
      </div>
    </div>
  )
}
