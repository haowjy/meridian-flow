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
      className="flex min-h-[400px] flex-col items-center justify-center rounded-lg border border-destructive/50 bg-destructive/10 p-8 text-center"
      role="alert"
    >
      <AlertCircle className="mb-4 h-12 w-12 text-destructive" />
      <h3 className="mb-2 text-xl font-semibold">{title}</h3>
      <p className="mb-4 text-muted-foreground">{message}</p>
      {onRetry && (
        <Button onClick={onRetry}>Retry</Button>
      )}
    </div>
  )
}
