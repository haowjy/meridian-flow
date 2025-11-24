import { Skeleton } from '@/shared/components/ui/skeleton'
import { cn } from '@/lib/utils'

export function AIMessageSkeleton() {
  return (
    <div className="flex flex-col items-stretch gap-1 group text-sm">
      <div
        className={cn(
          'w-full space-y-2 rounded-lg px-3 py-2',
          'chat-message chat-message--ai bg-card'
        )}
      >
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-11/12" />
      </div>
    </div>
  )
}
