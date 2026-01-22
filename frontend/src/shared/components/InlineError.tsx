import { OctagonX, X, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'

interface InlineErrorProps {
  message: string
  onRetry?: () => void
  onDismiss?: () => void
  className?: string
}

/**
 * Compact inline error component for contextual error display.
 *
 * Use this for errors that should appear near where they occurred
 * (e.g., save failures in editor, LLM errors in thread).
 *
 * For full-page errors, use ErrorPanel instead.
 */
export function InlineError({
  message,
  onRetry,
  onDismiss,
  className,
}: InlineErrorProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg border border-error/50 bg-error/10 px-3 py-2',
        className
      )}
      role="alert"
    >
      <OctagonX className="h-3 w-3 shrink-0 text-error" />
      <span className="flex-1 text-sm text-error select-all">
        {message}
      </span>
      {onRetry && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onRetry}
          className="h-7 px-2 text-xs hover:bg-error/20"
        >
          <RotateCcw className="mr-1 h-3 w-3" />
          Retry
        </Button>
      )}
      {onDismiss && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDismiss}
          className="hover:bg-error/20"
          aria-label="Dismiss error"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  )
}
