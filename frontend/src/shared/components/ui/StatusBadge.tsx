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
      className: 'text-yellow-600 bg-yellow-50 border-yellow-200',
      iconClassName: 'animate-spin',
    },
    local: {
      icon: Cloud,
      label: 'Saved locally',
      className: 'text-orange-600 bg-orange-50 border-orange-200',
      iconClassName: '',
    },
    saved: {
      icon: CheckCircle2,
      label: 'Saved',
      className: 'text-green-600 bg-green-50 border-green-200',
      iconClassName: '',
    },
    error: {
      icon: AlertCircle,
      label: 'Save failed',
      className: 'text-red-600 bg-red-50 border-red-200',
      iconClassName: '',
    },
  }

  const config = configs[status]
  const Icon = config.icon

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
        config.className,
        className
      )}
    >
      <Icon className={cn('h-3 w-3', config.iconClassName)} />
      <span>{config.label}</span>
    </div>
  )
}
