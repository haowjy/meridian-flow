'use client'

import { SaveStatusIcon } from './SaveStatusIcon'
import { formatRelative } from '@/core/lib/formatDate'
import { countWords } from '@/core/lib/countWords'
import { cn } from '@/lib/utils'
import type { SaveStatus } from '@/shared/components/ui/StatusBadge'

interface EditorStatusBarProps {
  content: string
  status: SaveStatus
  lastSaved: Date | null
  className?: string
}

export function EditorStatusBar({ content, status, lastSaved, className }: EditorStatusBarProps) {
  const words = countWords(content)
  return (
    <div
      className={cn(
        'inline-flex items-center gap-2.5 rounded-full bg-card/90 px-3.5 py-1.5 text-xs text-muted-foreground shadow-lg ring-1 ring-border/40 backdrop-blur',
        className
      )}
      aria-live="polite"
    >
      <div className="font-medium text-foreground">{words} {words === 1 ? 'word' : 'words'}</div>
      <div className="h-2.5 w-px bg-border/40" />
      <div className="inline-flex items-center gap-2">
        <SaveStatusIcon status={status} />
        {status === 'saved' && lastSaved ? <span>Saved {formatRelative(lastSaved)}</span> : null}
        {status === 'saving' ? <span>Saving…</span> : null}
        {status === 'error' ? <span>Save failed</span> : null}
        {status === 'local' ? <span>Saved locally</span> : null}
      </div>
    </div>
  )
}
