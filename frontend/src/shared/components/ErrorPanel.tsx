import { Button } from './ui/button'
import { AlertCircle } from 'lucide-react'

interface ErrorPanelProps {
  title?: string
  message: string
  onRetry?: () => void
}

export function ErrorPanel({
  title = 'Something went wrong',
  message,
  onRetry
}: ErrorPanelProps) {
  return (
    <div
      className="flex min-h-[400px] flex-col items-center justify-center rounded-lg border border-error/50 bg-error/10 p-8 text-center"
      role="alert"
    >
      <AlertCircle className="mb-4 h-12 w-12 text-error" />
      <h3 className="mb-2 type-section">{title}</h3>
      <p className="mb-4 type-body text-muted-foreground">{message}</p>
      {onRetry && (
        <Button onClick={onRetry}>Retry</Button>
      )}
    </div>
  )
}
