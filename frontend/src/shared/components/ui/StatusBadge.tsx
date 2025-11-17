import { Loader2, Cloud, CheckCircle2, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

export type SaveStatus = 'saving' | 'local' | 'saved' | 'error'

interface StatusBadgeProps {
  status: SaveStatus
  className?: string
}

/**
 * Status badge showing document save state.
 * - saving: Yellow spinner "Saving..."
 * - local: Orange cloud "Saved locally" (queued for backend sync)
 * - saved: Green checkmark "Saved" (backend confirmed)
 * - error: Red alert "Save failed"
 */
export function StatusBadge({ status, className }: StatusBadgeProps) {
  const configs = {
    saving: {
      icon: Loader2,
      label: 'Saving...',
      className: 'text-warning-foreground bg-warning/10 border-warning',
      iconClassName: 'animate-spin',
    },
    local: {
      icon: Cloud,
      label: 'Saved locally',
      className: 'text-warning-foreground bg-warning/10 border-warning',
      iconClassName: '',
    },
    saved: {
      icon: CheckCircle2,
      label: 'Saved',
      className: 'text-success-foreground bg-success/10 border-success',
      iconClassName: '',
    },
    error: {
      icon: AlertCircle,
      label: 'Save failed',
      className: 'text-error-foreground bg-error/10 border-error',
      iconClassName: '',
    },
  }

  const config = configs[status]
  const Icon = config.icon

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 border px-2.5 py-1 text-xs font-medium font-sans rounded-lg',
        config.className,
        className
      )}
    >
      <Icon className={cn('h-3 w-3', config.iconClassName)} />
      <span>{config.label}</span>
    </div>
  )
}
