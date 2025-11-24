import { Card } from '@/shared/components/ui/card'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { cn } from '@/lib/utils'

export function UserMessageSkeleton() {
  return (
    <div className="group flex flex-col items-end gap-1 text-sm">
      <Card className={cn('px-3 py-2', 'chat-message chat-message--user')}>
        <div className="space-y-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-40" />
        </div>
      </Card>
    </div>
  )
}
