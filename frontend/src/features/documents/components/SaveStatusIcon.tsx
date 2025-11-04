'use client'

import { Loader2, Cloud, AlertCircle, CloudOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SaveStatus } from '@/shared/components/ui/StatusBadge'

interface SaveStatusIconProps {
  status: SaveStatus
  className?: string
}

export function SaveStatusIcon({ status, className }: SaveStatusIconProps) {
  const map = {
    saving: { Icon: Loader2, className: 'animate-spin', label: 'Saving' },
    saved: { Icon: Cloud, className: '', label: 'Saved' },
    local: { Icon: CloudOff, className: '', label: 'Saved locally' },
    error: { Icon: AlertCircle, className: '', label: 'Save failed' },
  }
  const { Icon, className: extra, label } = map[status]
  return <Icon aria-label={label} className={cn('h-4 w-4', extra, className)} />
}
